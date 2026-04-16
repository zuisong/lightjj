package api

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chronologos/lightjj/internal/jj"
	"github.com/chronologos/lightjj/testutil"
	"github.com/stretchr/testify/assert"
)

func TestWatcher_SubscribeBroadcast(t *testing.T) {
	w := &Watcher{
		subs: make(map[chan string]struct{}),
	}

	ch1, unsub1 := w.subscribe()
	ch2, unsub2 := w.subscribe()
	defer unsub1()
	defer unsub2()

	w.broadcast("abc123")

	select {
	case got := <-ch1:
		assert.Equal(t, "abc123", got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch1 did not receive broadcast")
	}
	select {
	case got := <-ch2:
		assert.Equal(t, "abc123", got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch2 did not receive broadcast")
	}
}

func TestWatcher_BroadcastDropsOnFullBuffer(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	// Fill the buffer (cap 4), then broadcast again — fifth should be dropped
	// without blocking. Buffer is 4 (not 1) so sentinel events aren't dropped
	// by a single buffered op-id.
	for i := range 4 {
		w.broadcast(string(rune('a' + i)))
	}
	done := make(chan struct{})
	go func() {
		w.broadcast("dropped")
		close(done)
	}()
	select {
	case <-done:
		// good — did not block
	case <-time.After(100 * time.Millisecond):
		t.Fatal("broadcast blocked on full buffer")
	}

	assert.Equal(t, "a", <-ch)
	assert.Equal(t, "b", <-ch)
	assert.Equal(t, "c", <-ch)
	assert.Equal(t, "d", <-ch)
	// Channel should now be empty; "dropped" was dropped.
	select {
	case v := <-ch:
		t.Fatalf("expected empty channel, got %q", v)
	default:
	}
}

func TestWatcher_UnsubscribeStopsDelivery(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	unsub()

	w.broadcast("abc")
	select {
	case v := <-ch:
		t.Fatalf("received after unsubscribe: %q", v)
	default:
	}
}

func TestWatcher_BroadcastEmptyIsNoop(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	w.broadcast("")
	select {
	case v := <-ch:
		t.Fatalf("empty broadcast delivered: %q", v)
	default:
	}
}

// setStale serializes Swap+broadcast so two callers can't interleave and emit
// sentinels out-of-order (the 2026-03-18 confirmed race). This test doesn't
// prove the race is fixed (races don't manifest deterministically), but it
// locks the INVARIANT: setStale(v) broadcasts IFF the value changed, and the
// broadcast value matches the new state. Four inline sites + two handler calls
// all go through this; if any reverts to inline Swap+broadcast the atomicity
// guarantee is lost.
func TestWatcher_SetStale_EdgeOnlyBroadcast(t *testing.T) {
	w := &Watcher{subs: make(map[chan string]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	drain := func() (got []string) {
		for {
			select {
			case v := <-ch:
				got = append(got, v)
			default:
				return
			}
		}
	}

	// false→true: one stale-wc
	w.setStale(true)
	assert.Equal(t, []string{evStaleWC}, drain())
	// true→true: no-op
	w.setStale(true)
	assert.Empty(t, drain())
	// true→false: one fresh-wc
	w.setStale(false)
	assert.Equal(t, []string{evFreshWC}, drain())
	// false→false: no-op
	w.setStale(false)
	assert.Empty(t, drain())
}

func TestIsStaleWCError(t *testing.T) {
	// WorkingCopyStale (cli_util.rs:2734)
	assert.True(t, isStaleWCError(errors.New("Error: The working copy is stale (not updated since operation abc123).")))
	// ObjectNotFound (cli_util.rs:2762) — WC op was GC'd; same update-stale fix
	assert.True(t, isStaleWCError(errors.New("Error: Could not read working copy's operation.")))
	// SiblingOperation (cli_util.rs:2744) — different fix (jj op integrate), must NOT match
	assert.False(t, isStaleWCError(errors.New("The repo was loaded at operation abc, which seems to be a sibling of the working copy's operation def")))
	// Generic
	assert.False(t, isStaleWCError(errors.New("exit status 1: repo lock held")))
	assert.False(t, isStaleWCError(nil))
}

// safeRecorder is a goroutine-safe http.ResponseWriter for SSE handler tests.
// httptest.ResponseRecorder.Body is a bare bytes.Buffer — polling it while
// handleEvents writes from its goroutine is a data race (-race flags it on
// every TestHandleEvents_* below). Implements http.Flusher (handleEvents
// type-asserts it at watcher.go:420).
type safeRecorder struct {
	mu   sync.Mutex
	hdr  http.Header
	body bytes.Buffer
}

func newSafeRecorder() *safeRecorder              { return &safeRecorder{hdr: make(http.Header)} }
func (r *safeRecorder) Header() http.Header       { return r.hdr }
func (r *safeRecorder) WriteHeader(int)           {}
func (r *safeRecorder) Flush()                    {}
func (r *safeRecorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(p)
}
func (r *safeRecorder) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func TestHandleEvents_MetaEventSentinel(t *testing.T) {
	srv := &Server{cachedOp: "op-before"}
	watcher := &Watcher{
		srv:  srv,
		subs: make(map[chan string]struct{}),
		stop: make(chan struct{}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	rec := newSafeRecorder()

	done := make(chan struct{})
	go func() {
		watcher.handleEvents(rec, req)
		close(done)
	}()

	// Wait for subscriber to register, then broadcast the sentinel.
	assert.Eventually(t, watcher.hasSubscribers, time.Second, 5*time.Millisecond)
	watcher.broadcast(evStaleWC)

	assert.Eventually(t, func() bool {
		return strings.Contains(rec.String(), "event: stale-wc")
	}, time.Second, 10*time.Millisecond)

	cancel()
	<-done

	body := rec.String()
	assert.Contains(t, body, "event: stale-wc\ndata: {}", "sentinel should emit as named SSE event")
	// Initial op-id still written (sentinel doesn't interfere with op path).
	assert.Contains(t, body, `"op_id":"op-before"`)
}

func TestHandleEvents_EmitsStaleStateOnConnect(t *testing.T) {
	// Both branches — true emits stale-wc, false emits fresh-wc. The false
	// branch matters: a client whose SSE dropped during staleness and
	// reconnected after CLI recovery would otherwise have workspaceStale
	// stuck true (the fresh-wc broadcast was sent while disconnected).
	for _, tc := range []struct {
		stale bool
		want  string
	}{
		{true, "event: stale-wc\ndata: {}"},
		{false, "event: fresh-wc\ndata: {}"},
	} {
		srv := &Server{cachedOp: "some-op"}
		watcher := &Watcher{
			srv:  srv,
			subs: make(map[chan string]struct{}),
			stop: make(chan struct{}),
		}
		watcher.stale.Store(tc.stale)

		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
		rec := newSafeRecorder()

		done := make(chan struct{})
		go func() {
			watcher.handleEvents(rec, req)
			close(done)
		}()

		assert.Eventually(t, func() bool {
			return strings.Contains(rec.String(), tc.want)
		}, time.Second, 10*time.Millisecond)
		cancel()
		<-done
		assert.Contains(t, rec.String(), tc.want, "stale=%v", tc.stale)
	}
}

func TestHandleEventsDisabled(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/events", nil)
	w := httptest.NewRecorder()
	handleEventsDisabled(w, req)
	assert.Equal(t, http.StatusNoContent, w.Code)
}

// handleEvents sends event:op on connect. If cachedOp is empty (read-only
// session — no mutations to advance it), handleEvents must refresh so the
// frontend's everSawEvent gets set. Without this, first SSE drop = permanent
// auto-refresh loss (api.ts:~311 gives up immediately if everSawEvent=false).
func TestHandleEvents_SendsInitialOpIdOnConnect(t *testing.T) {
	for _, tc := range []struct {
		name    string
		cached  string
		runner  bool // seed a MockRunner that returns "fetched-op"
		wantOp  string
	}{
		// Cached value present — send directly, no refresh.
		{"cached", "cached-op", false, "cached-op"},
		// Cached empty — handleEvents refreshes via Runner (the read-only
		// session path). Previously this skipped the event entirely.
		{"empty-refreshes", "", true, "fetched-op"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := &Server{cachedOp: tc.cached}
			if tc.runner {
				r := testutil.NewMockRunner(t)
				r.Expect(jj.CurrentOpId()).SetOutput([]byte(tc.wantOp))
				defer r.Verify()
				srv.Runner = r
			}
			watcher := &Watcher{srv: srv, subs: make(map[chan string]struct{})}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
			rec := newSafeRecorder()

			done := make(chan struct{})
			go func() { watcher.handleEvents(rec, req); close(done) }()

			assert.Eventually(t, func() bool {
				return strings.Contains(rec.String(), tc.wantOp)
			}, time.Second, 10*time.Millisecond)
			cancel()
			<-done

			body := rec.String()
			assert.Contains(t, body, "event: op")
			assert.Contains(t, body, `"op_id":"`+tc.wantOp+`"`)
		})
	}
}

func TestServerEventsRoute_NilWatcher(t *testing.T) {
	// Server with no watcher (SSH mode) should return 204.
	srv := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/api/events", nil)
	w := httptest.NewRecorder()
	srv.Mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusNoContent, w.Code)
}

// --- sshPollLoop tests ----------------------------------------------------
//
// sshPollLoop uses Runner.Run(PollOpId()) — MockRunner scripts the output
// sequence without any SSH. Short interval (~5ms) keeps tests fast.

// seqRunner returns successive outputs from a slice, then repeats the last.
// Not thread-safe — sshPollLoop calls Run() serially (one-at-a-time ticker).
// Embeds MockRunner only for interface satisfaction (RunWithInput, RunRaw,
// etc. — never called); its `t` field is nil, which would panic on
// findExpectation, but Run() is overridden so that path is unreachable.
type seqRunner struct {
	testutil.MockRunner
	outputs []string
	calls   atomic.Int32
	// Optional per-call hook fired BEFORE returning output. Used by CAS tests
	// to simulate a concurrent runMutation advancing cachedOp mid-SSH-call.
	hook func(callIdx int)

	mu      sync.Mutex
	argsLog [][]string
}

func (r *seqRunner) Run(_ context.Context, args []string) ([]byte, error) {
	r.mu.Lock()
	r.argsLog = append(r.argsLog, args)
	r.mu.Unlock()
	n := int(r.calls.Add(1)) - 1
	if n >= len(r.outputs) {
		n = len(r.outputs) - 1
	}
	if r.hook != nil {
		r.hook(n)
	}
	return []byte(r.outputs[n]), nil
}

func (r *seqRunner) lastArgs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.argsLog) == 0 {
		return nil
	}
	return r.argsLog[len(r.argsLog)-1]
}

func TestSSHPollLoop_BroadcastsOnChange(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-aaa", "op-aaa", "op-bbb"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	ch, unsub := w.subscribe() // hasSubscribers gate
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First poll: "" → "op-aaa" = change → broadcast.
	select {
	case got := <-ch:
		assert.Equal(t, "op-aaa", got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no first broadcast")
	}
	// Second poll returns same "op-aaa" → no broadcast. Third returns "op-bbb".
	select {
	case got := <-ch:
		assert.Equal(t, "op-bbb", got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no second broadcast")
	}
	// cachedOp reflects the latest poll (direct write, not via refreshOpId).
	assert.Equal(t, "op-bbb", srv.getOpId())

	close(w.stop)
	<-done
}

// Between-tick mutation: runMutation advances cachedOp BETWEEN poll ticks
// (not during the SSH call). The next poll returns the same value cachedOp
// already has (remote state matches). Mutating tab got the X-JJ-Op-Id header;
// non-mutating tabs rely on SSE broadcast. Comparing against lastBroadcast
// (local — what WE last sent) not preCached (shared — reflects the mutation)
// is what lets the poll detect and broadcast this. The CAS fix's first cut
// collapsed these → bug_017 (between-tick mutations silently dropped).
func TestSSHPollLoop_BroadcastsBetweenTickMutation(t *testing.T) {
	// cachedOp starts at A (seeded by handleEvents refresh). Between ticks,
	// a "mutation" advances it to B. Poll returns B (remote matches).
	// preCached=B (reads shared), opId=B → opId==preCached would skip.
	// lastBroadcast="" (we never broadcast yet) → opId!=lastBroadcast → emit.
	srv := &Server{}
	srv.cachedOp = "op-B" // already advanced by a mutation's refreshOpId

	r := &seqRunner{outputs: []string{"op-B", "op-B"}} // poll returns what cachedOp already is
	srv.Runner = r

	w := newWatcher(srv)
	ch, unsub := w.subscribe()
	defer unsub()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// Must broadcast B — lastBroadcast="" so opId!=lastBroadcast. The CAS
	// (cur==preCached, both B) passes, write is a no-op (B→B), broadcast B.
	select {
	case got := <-ch:
		assert.Equal(t, "op-B", got, "between-tick mutation must broadcast to other tabs")
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no broadcast — non-mutating tabs would never refresh")
	}

	close(w.stop)
	<-done
}

// sshPollLoop CAS: if a concurrent runMutation advances cachedOp while the
// poll's SSH call is in flight (returning a value captured BEFORE the
// mutation), the poll must not regress cachedOp. Previously the unconditional
// write would overwrite the mutation's fresher value with the poll's stale
// snapshot (~18% probability per mutation: 880ms/5000ms). The CAS now
// compares against pre-poll cachedOp; mismatch = concurrent advance → skip
// write, broadcast the advanced value so non-mutating clients still refresh.
func TestSSHPollLoop_CASGuardsConcurrentAdvance(t *testing.T) {
	srv := &Server{}
	srv.cachedOp = "op-A" // seeded (handleEvents refresh, or prior poll)

	// Poll 0: preCached=A, SSH call starts; DURING the call, a "mutation"
	//         (hook) advances cachedOp to C. SSH returns B (captured between
	//         A and C — a CLI mutation on the remote). CAS: cachedOp==A? →
	//         no (it's C) → don't write B. Broadcast C (the fresher value).
	// Poll 1: preCached=C, SSH returns C (remote caught up). No change, skip.
	r := &seqRunner{
		outputs: []string{"op-B", "op-C"},
		hook: func(i int) {
			if i == 0 {
				srv.cachedMu.Lock()
				srv.cachedOp = "op-C" // concurrent runMutation's refreshOpId
				srv.cachedMu.Unlock()
			}
		},
	}
	srv.Runner = r

	w := newWatcher(srv)
	ch, unsub := w.subscribe()
	defer unsub()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First broadcast is C (the advanced value), NOT B (the stale poll result).
	select {
	case got := <-ch:
		assert.Equal(t, "op-C", got, "must broadcast advanced value, not stale poll result")
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no broadcast")
	}
	// cachedOp NOT regressed to B.
	assert.Equal(t, "op-C", srv.getOpId())

	// Poll 1 returns C == cachedOp → no broadcast.
	select {
	case v := <-ch:
		t.Fatalf("unexpected second broadcast: %q", v)
	case <-time.After(20 * time.Millisecond):
	}

	close(w.stop)
	<-done
}

func TestSSHPollLoop_NoSubscribers_NoPolls(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	w := newWatcher(&Server{Runner: r})
	// No subscribe() — hasSubscribers() stays false.

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	time.Sleep(50 * time.Millisecond) // ~10 tick opportunities
	close(w.stop)
	<-done

	assert.Zero(t, r.calls.Load(), "polled with no subscribers")
}

func TestSSHPollLoop_PausedFallsBackToCurrentOpId(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w
	_, unsub := w.subscribe()
	defer unsub()

	resume := srv.pauseSnapshot()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	assert.Eventually(t, func() bool { return r.calls.Load() > 0 }, time.Second, 5*time.Millisecond)
	assert.Equal(t, jj.CurrentOpId(), r.lastArgs(), "paused: must use --ignore-working-copy variant")

	resume()
	assert.Eventually(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, a := range r.argsLog {
			if slices.Equal(a, jj.PollOpId()) {
				return true
			}
		}
		return false
	}, time.Second, 5*time.Millisecond, "resumed: must switch back to PollOpId")

	close(w.stop)
	<-done
}

func TestSSHPollLoop_PausedDoesNotClearStale(t *testing.T) {
	r := &seqRunner{outputs: []string{"op-x"}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w
	w.stale.Store(true)
	_, unsub := w.subscribe()
	defer unsub()

	resume := srv.pauseSnapshot()
	defer resume()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	assert.Eventually(t, func() bool { return r.calls.Load() > 2 }, time.Second, 5*time.Millisecond)
	assert.True(t, w.stale.Load(), "CurrentOpId success must not clear stale (it has --ignore-working-copy)")

	close(w.stop)
	<-done
}

func TestPauseSnapshot_NestedCounter(t *testing.T) {
	srv := &Server{}
	srv.Watcher = newWatcher(srv)
	r1 := srv.pauseSnapshot()
	r2 := srv.pauseSnapshot()
	assert.EqualValues(t, 2, srv.Watcher.snapshotPaused.Load())
	r1()
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load(), "first resume must not unpause overlapping mutation")
	r1() // double-call must be safe (sync.Once)
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load(), "non-idempotent resume would steal r2's count")
	r2()
	assert.EqualValues(t, 0, srv.Watcher.snapshotPaused.Load())
}

func TestPauseSnapshot_WatchdogReleases(t *testing.T) {
	old := snapshotPauseMax
	snapshotPauseMax = 20 * time.Millisecond
	defer func() { snapshotPauseMax = old }()

	srv := &Server{}
	srv.Watcher = newWatcher(srv)
	resume := srv.pauseSnapshot()
	assert.EqualValues(t, 1, srv.Watcher.snapshotPaused.Load())
	assert.Eventually(t, func() bool { return srv.Watcher.snapshotPaused.Load() == 0 },
		time.Second, 5*time.Millisecond, "watchdog must release a hung mutation's pause")
	resume() // must not double-decrement (Once)
	assert.EqualValues(t, 0, srv.Watcher.snapshotPaused.Load())
}

func TestTrySnapshot_SkipsWhenPaused(t *testing.T) {
	r := &seqRunner{outputs: []string{""}}
	srv := &Server{Runner: r}
	srv.Watcher = newWatcher(srv)

	resume := srv.pauseSnapshot()
	ran, err := srv.trySnapshot(context.Background())
	assert.False(t, ran)
	assert.NoError(t, err)
	assert.Zero(t, r.calls.Load())

	resume()
	ran, _ = srv.trySnapshot(context.Background())
	assert.True(t, ran)
	assert.Equal(t, jj.DebugSnapshot(), r.lastArgs())
}


func TestSSHPollLoop_StopsCleanly(t *testing.T) {
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetOutput([]byte("op-x"))
	w := newWatcher(NewServer(r, ""))
	_, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	time.Sleep(20 * time.Millisecond)
	close(w.stop)

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("sshPollLoop did not exit after Close")
	}
}

func TestSSHPollLoop_ErrorsDoNotBroadcastOrExit(t *testing.T) {
	// Poll failure → no broadcast, loop keeps running. Error-threshold
	// logging (3x, then every 12) is shared with snapshotLoop — trusted.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("ssh timeout"))
	w := newWatcher(NewServer(r, ""))
	ch, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// Several failing polls — no broadcasts, loop stays alive.
	select {
	case v := <-ch:
		t.Fatalf("unexpected broadcast on error: %q", v)
	case <-time.After(30 * time.Millisecond):
	}

	close(w.stop)
	<-done
}

func TestNewSSHWatcher_IntervalZero(t *testing.T) {
	// --snapshot-interval 0 must not start the loop. Parity with local
	// mode's snapshotLoop gate at watcher.go:~124. Also prevents
	// time.NewTicker(0) panic. MockRunner has no expectations — any
	// Run() call (from a tick) would t.Fatalf on unexpected command.
	r := testutil.NewMockRunner(t)
	defer r.Verify()
	w := NewSSHWatcher(NewServer(r, ""), 0)
	_, unsub := w.subscribe() // subscriber present → would poll if loop was running
	defer unsub()
	time.Sleep(20 * time.Millisecond)
	close(w.stop)
}

func TestSSHPollLoop_StaleWCSentinel(t *testing.T) {
	// sshPollLoop now snapshots (PollOpId without --ignore-working-copy),
	// so it can hit stale-WC. Same sentinel routing as snapshotLoop:
	// broadcast evStaleWC on edge, evFreshWC on recovery. seqRunner can't
	// script errors, so use MockRunner with a stale-WC-matching string
	// (isStaleWCError matches on message content).
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("Error: The working copy is stale (not updated since operation abc)."))
	w := newWatcher(NewServer(r, ""))
	ch, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// First stale error → evStaleWC sentinel (once — Swap edge)
	select {
	case v := <-ch:
		assert.Equal(t, evStaleWC, v)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("no stale sentinel")
	}
	// Subsequent stale errors → no re-broadcast (Swap returns true)
	select {
	case v := <-ch:
		t.Fatalf("re-broadcast on repeated stale: %q", v)
	case <-time.After(20 * time.Millisecond):
	}
	assert.True(t, w.stale.Load())

	close(w.stop)
	<-done
}

