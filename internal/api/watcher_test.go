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
	"github.com/stretchr/testify/require"
)

func TestWatcher_SubscribeBroadcast(t *testing.T) {
	w := &Watcher{
		subs: make(map[chan sseEvent]struct{}),
	}

	ch1, unsub1 := w.subscribe()
	ch2, unsub2 := w.subscribe()
	defer unsub1()
	defer unsub2()

	w.broadcast(opEvent("abc123"))

	select {
	case got := <-ch1:
		assert.Equal(t, opEvent("abc123"), got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch1 did not receive broadcast")
	}
	select {
	case got := <-ch2:
		assert.Equal(t, opEvent("abc123"), got)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("ch2 did not receive broadcast")
	}
}

func TestWatcher_BroadcastDropsOnFullBuffer(t *testing.T) {
	w := &Watcher{subs: make(map[chan sseEvent]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	// Fill the buffer (cap 6) with droppable op-id events, then broadcast
	// again — the seventh should be dropped without blocking. Op-ids are
	// droppable: the client coalesces consecutive refreshes anyway.
	for i := range 6 {
		w.broadcast(opEvent(string(rune('a' + i))))
	}
	done := make(chan struct{})
	go func() {
		w.broadcast(opEvent("dropped"))
		close(done)
	}()
	select {
	case <-done:
		// good — did not block
	case <-time.After(100 * time.Millisecond):
		t.Fatal("broadcast blocked on full buffer")
	}

	assert.Equal(t, opEvent("a"), <-ch)
	assert.Equal(t, opEvent("b"), <-ch)
	assert.Equal(t, opEvent("c"), <-ch)
	assert.Equal(t, opEvent("d"), <-ch)
	assert.Equal(t, opEvent("e"), <-ch)
	assert.Equal(t, opEvent("f"), <-ch)
	// Channel should now be empty; "dropped" was dropped.
	select {
	case v := <-ch:
		t.Fatalf("expected empty channel, got %v", v)
	default:
	}
}

// Non-droppable sentinel events must survive a buffer full of droppable
// op-ids: broadcast evicts the oldest queued event to make room instead of
// dropping the sentinel. Sentinels are edge-triggered and never re-sent, so
// dropping one would leave the client stuck (e.g. on stale=false) until SSE
// reconnect.
func TestWatcher_SentinelNotDroppedWhenBufferFull(t *testing.T) {
	w := &Watcher{subs: make(map[chan sseEvent]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	// Fill the buffer (cap 6) with droppable op-id events.
	for i := range 6 {
		w.broadcast(opEvent(string(rune('a' + i))))
	}
	// Sentinel must not be dropped — oldest op-id ("a") gets evicted.
	w.broadcast(evStaleWC)

	var got []sseEvent
	for {
		select {
		case v := <-ch:
			got = append(got, v)
			continue
		default:
		}
		break
	}
	assert.Equal(t, []sseEvent{
		opEvent("b"), opEvent("c"), opEvent("d"), opEvent("e"), opEvent("f"), evStaleWC,
	}, got, "sentinel must arrive; oldest droppable event is evicted")
}

func TestWatcher_UnsubscribeStopsDelivery(t *testing.T) {
	w := &Watcher{subs: make(map[chan sseEvent]struct{})}
	ch, unsub := w.subscribe()
	unsub()

	w.broadcast(opEvent("abc"))
	select {
	case v := <-ch:
		t.Fatalf("received after unsubscribe: %v", v)
	default:
	}
}

func TestWatcher_BroadcastEmptyIsNoop(t *testing.T) {
	w := &Watcher{subs: make(map[chan sseEvent]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	// opEvent("") is the zero event — broadcast must ignore it.
	w.broadcast(opEvent(""))
	select {
	case v := <-ch:
		t.Fatalf("empty broadcast delivered: %v", v)
	default:
	}
}

// setStale serializes Swap+broadcast so two callers can't interleave and emit
// sentinels out-of-order (the 2026-03-18 confirmed race). This test doesn't
// prove the race is fixed (races don't manifest deterministically), but it
// locks the INVARIANT: setStale(v) broadcasts IFF the value changed, and the
// broadcast value matches the new state. The probeTracker call sites + two
// handler calls all go through this; if any reverts to inline Swap+broadcast
// the atomicity guarantee is lost.
func TestWatcher_SetStale_EdgeOnlyBroadcast(t *testing.T) {
	w := &Watcher{subs: make(map[chan sseEvent]struct{})}
	ch, unsub := w.subscribe()
	defer unsub()

	drain := func() (got []sseEvent) {
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
	assert.Equal(t, []sseEvent{evStaleWC}, drain())
	// true→true: no-op
	w.setStale(true)
	assert.Empty(t, drain())
	// true→false: one fresh-wc
	w.setStale(false)
	assert.Equal(t, []sseEvent{evFreshWC}, drain())
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

// Watchers constructed for servers at the same canonical repo path share one
// snapshot-pause counter (resolved at construction via pauseCounterFor) — a
// mutation in one tab must pause snapshots in every tab pointed at the same
// working copy. Different paths get independent counters; no path (tests,
// no repo) gets a private one.
func TestWatcher_SharedPauseCounterByPath(t *testing.T) {
	mk := func(repoDir string) *Server {
		s := &Server{RepoDir: repoDir}
		s.Watcher = newWatcher(s)
		return s
	}
	a := mk("/watcher-test/repo/one")
	b := mk("/watcher-test/repo/one")
	c := mk("/watcher-test/repo/two")
	d := mk("") // no path → private counter

	require.Same(t, a.Watcher.snapshotPaused, b.Watcher.snapshotPaused, "same-path watchers must share counter")
	require.NotSame(t, a.Watcher.snapshotPaused, c.Watcher.snapshotPaused)
	require.NotSame(t, a.Watcher.snapshotPaused, d.Watcher.snapshotPaused)

	resume := a.pauseSnapshot()
	assert.EqualValues(t, 1, b.Watcher.snapshotPaused.Load(), "pause via server A must pause same-path server B")
	assert.EqualValues(t, 0, c.Watcher.snapshotPaused.Load())

	ran, _ := b.trySnapshot(context.Background())
	assert.False(t, ran, "B's trySnapshot must skip while A's mutation is in flight")

	resume()
	assert.EqualValues(t, 0, b.Watcher.snapshotPaused.Load())
}

// safeRecorder is a goroutine-safe http.ResponseWriter for SSE handler tests.
// httptest.ResponseRecorder.Body is a bare bytes.Buffer — polling it while
// handleEvents writes from its goroutine is a data race (-race flags it on
// every TestHandleEvents_* below). Implements http.Flusher (handleEvents
// type-asserts it at the top of the handler).
type safeRecorder struct {
	mu   sync.Mutex
	hdr  http.Header
	body bytes.Buffer
}

func newSafeRecorder() *safeRecorder        { return &safeRecorder{hdr: make(http.Header)} }
func (r *safeRecorder) Header() http.Header { return r.hdr }
func (r *safeRecorder) WriteHeader(int)     {}
func (r *safeRecorder) Flush()              {}
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
		subs: make(map[chan sseEvent]struct{}),
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
			subs: make(map[chan sseEvent]struct{}),
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
		name   string
		cached string
		runner bool // seed a MockRunner that returns "fetched-op"
		wantOp string
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
			watcher := &Watcher{srv: srv, subs: make(map[chan sseEvent]struct{})}

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
	// to simulate a concurrent runMutation advancing the op-id cache mid-SSH-call.
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
		assert.Equal(t, opEvent("op-aaa"), got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no first broadcast")
	}
	// Second poll returns same "op-aaa" → no broadcast. Third returns "op-bbb".
	select {
	case got := <-ch:
		assert.Equal(t, opEvent("op-bbb"), got)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no second broadcast")
	}
	// Cached op-id reflects the latest poll (direct cache write, not via refreshOpId).
	assert.Equal(t, "op-bbb", srv.getOpId())

	close(w.stop)
	<-done
}

// Between-tick mutation: runMutation advances the op-id cache BETWEEN poll
// ticks (not during the SSH call). The next poll returns the same value the
// cache already has (remote state matches). Mutating tab got the X-JJ-Op-Id
// header; non-mutating tabs rely on SSE broadcast. Comparing against
// lastBroadcast (local — what WE last sent) not preCached (shared — reflects
// the mutation) is what lets the poll detect and broadcast this. The CAS fix's
// first cut collapsed these → bug_017 (between-tick mutations silently dropped).
func TestSSHPollLoop_BroadcastsBetweenTickMutation(t *testing.T) {
	// Cache starts at B (already advanced by a mutation's refreshOpId).
	// Poll returns B (remote matches). preCached=B (reads shared), opId=B →
	// opId==preCached would skip. lastBroadcast="" (we never broadcast yet)
	// → opId!=lastBroadcast → emit.
	srv := &Server{}
	srv.setOpId("op-B") // already advanced by a mutation's refreshOpId

	r := &seqRunner{outputs: []string{"op-B", "op-B"}} // poll returns what the cache already holds
	srv.Runner = r

	w := newWatcher(srv)
	ch, unsub := w.subscribe()
	defer unsub()
	done := make(chan struct{})
	go func() { w.sshPollLoop(5 * time.Millisecond); close(done) }()

	// Must broadcast B — lastBroadcast="" so opId!=lastBroadcast. The CAS
	// (cache==preCached, both B) passes, write is a no-op (B→B), broadcast B.
	select {
	case got := <-ch:
		assert.Equal(t, opEvent("op-B"), got, "between-tick mutation must broadcast to other tabs")
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no broadcast — non-mutating tabs would never refresh")
	}

	close(w.stop)
	<-done
}

// sshPollLoop CAS: if a concurrent runMutation advances the op-id cache while
// the poll's SSH call is in flight (returning a value captured BEFORE the
// mutation), the poll must not regress the cache. Previously the unconditional
// write would overwrite the mutation's fresher value with the poll's stale
// snapshot (~18% probability per mutation: 880ms/5000ms). The CAS (casOpId)
// compares against pre-poll cache value; mismatch = concurrent advance → skip
// write, broadcast the advanced value so non-mutating clients still refresh.
func TestSSHPollLoop_CASGuardsConcurrentAdvance(t *testing.T) {
	srv := &Server{}
	srv.setOpId("op-A") // seeded (handleEvents refresh, or prior poll)

	// Poll 0: preCached=A, SSH call starts; DURING the call, a "mutation"
	//         (hook) advances the cache to C. SSH returns B (captured between
	//         A and C — a CLI mutation on the remote). CAS: cache==A? →
	//         no (it's C) → don't write B. Broadcast C (the fresher value).
	// Poll 1: preCached=C, SSH returns C (remote caught up). No change, skip.
	r := &seqRunner{
		outputs: []string{"op-B", "op-C"},
		hook: func(i int) {
			if i == 0 {
				srv.setOpId("op-C") // concurrent runMutation's refreshOpId
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
		assert.Equal(t, opEvent("op-C"), got, "must broadcast advanced value, not stale poll result")
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no broadcast")
	}
	// Cache NOT regressed to B.
	assert.Equal(t, "op-C", srv.getOpId())

	// Poll 1 returns C == cache → no broadcast.
	select {
	case v := <-ch:
		t.Fatalf("unexpected second broadcast: %v", v)
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

func TestSSHPollLoop_ErrorsDoNotBroadcastBelowThreshold(t *testing.T) {
	// Below pollFailThreshold, failures are absorbed silently: no broadcast,
	// loop keeps running. Transient contention (repo lock, SSH blip) should
	// not surface a UI warning.
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

	// ~3 ticks in 15ms — below pollFailThreshold (5).
	select {
	case v := <-ch:
		t.Fatalf("unexpected broadcast on error: %v", v)
	case <-time.After(15 * time.Millisecond):
	}

	close(w.stop)
	<-done
}

func TestSSHPollLoop_BroadcastsPollFailAtThreshold(t *testing.T) {
	// At pollFailThreshold consecutive errors, broadcast pollfail carrying
	// the error text. Edge-triggered: subsequent errors keep updating the
	// error text but don't re-broadcast until recovery → re-failure.
	r := testutil.NewMockRunner(t)
	r.Allow(jj.PollOpId()).SetError(errors.New("index.lock could not be acquired"))
	w := newWatcher(NewServer(r, ""))
	ch, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.sshPollLoop(3 * time.Millisecond); close(done) }()

	// Wait for pollFailThreshold (5) ticks: ~15ms + headroom. First event
	// should be pollfail with the error payload.
	select {
	case v := <-ch:
		assert.Equal(t, pollFailEvent("index.lock could not be acquired"), v)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("did not broadcast pollfail at threshold")
	}
	failed, errStr := w.pollStatus()
	if !failed {
		t.Fatal("expected pollFailed=true")
	}
	if errStr == "" {
		t.Fatal("expected non-empty pollErr")
	}

	close(w.stop)
	<-done
}

func TestNewSSHWatcher_IntervalZero(t *testing.T) {
	// --snapshot-interval 0 must not start the loop. Parity with local
	// mode's snapshotLoop gate in start(). Also prevents time.NewTicker(0)
	// panic. MockRunner has no expectations — any Run() call (from a tick)
	// would t.Fatalf on unexpected command.
	r := testutil.NewMockRunner(t)
	defer r.Verify()
	w := NewSSHWatcher(NewServer(r, ""), 0)
	_, unsub := w.subscribe() // subscriber present → would poll if loop was running
	defer unsub()
	time.Sleep(20 * time.Millisecond)
	close(w.stop)
}

// scriptedRunner returns a scripted sequence of (output, error) pairs. Unlike
// seqRunner (success-only), this lets a test drive a loop through
// failure→stale→recovery state transitions in order.
type scriptedRunner struct {
	testutil.MockRunner
	steps []struct {
		out string
		err error
	}
	calls atomic.Int32
}

func (r *scriptedRunner) Run(_ context.Context, args []string) ([]byte, error) {
	n := int(r.calls.Add(1)) - 1
	if n >= len(r.steps) {
		n = len(r.steps) - 1
	}
	return []byte(r.steps[n].out), r.steps[n].err
}

func TestSSHPollLoop_StaleInterludeDoesNotLeavePollFailedStuck(t *testing.T) {
	// Regression: stale-WC after a pollfail streak was leaving pollFailed
	// stuck forever. Counter-gated success-branch clear (`consecutiveErrors
	// >= pollFailThreshold`) never fired because stale-WC branch reset the
	// counter to 0 → next success checked `0 >= 5` = false → no clear.
	// The discipline now lives in probeTracker: ok()/staleWC() clear
	// poll-fail unconditionally.
	// Sequence: 5 generic errors (→ pollfail broadcast) → 1 stale-WC
	// (counter zeroed) → successful poll (must clear pollFailed).
	r := &scriptedRunner{steps: []struct {
		out string
		err error
	}{
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("ssh timeout")},
		{"", errors.New("Error: The working copy is stale (not updated since operation abc).")},
		{"op-fresh", nil},
	}}
	w := newWatcher(NewServer(r, ""))
	ch, unsub := w.subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() { w.sshPollLoop(3 * time.Millisecond); close(done) }()

	// Collect events with a timeout — we expect: pollfail → stale-wc →
	// pollok → op. (pollok may arrive via the stale branch's poll-fail clear
	// OR via the success branch — both are correct per the fix.)
	seen := make(map[string]bool)
	deadline := time.After(200 * time.Millisecond)
gather:
	for {
		select {
		case v := <-ch:
			seen[v.name] = true
			// Stop once we've seen pollfail AND pollok — the key invariant.
			if seen[evNamePollFail] && seen[evNamePollOk] {
				break gather
			}
		case <-deadline:
			break gather
		}
	}
	close(w.stop)
	<-done

	assert.True(t, seen[evNamePollFail], "expected pollfail broadcast during failure streak")
	assert.True(t, seen[evNamePollOk], "expected pollok broadcast after stale-interlude + success")
	failed, _ := w.pollStatus()
	assert.False(t, failed, "pollFailed must not remain stuck after stale interlude")
}

// snapshotLoop shares probeTracker with sshPollLoop, so the same stale-
// interlude regression is locked on the local-mode loop too: a pollfail
// streak followed by a stale-WC snapshot followed by a successful snapshot
// must end with pollFailed=false.
func TestSnapshotLoop_StaleInterludeDoesNotLeavePollFailedStuck(t *testing.T) {
	r := &scriptedRunner{steps: []struct {
		out string
		err error
	}{
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("repo lock held")},
		{"", errors.New("Error: The working copy is stale (not updated since operation abc).")},
		{"", nil},
	}}
	srv := &Server{Runner: r}
	w := newWatcher(srv)
	srv.Watcher = w // trySnapshot consults srv.Watcher.snapshotPaused
	ch, unsub := w.subscribe()
	defer unsub()

	var logBuf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOut)

	done := make(chan struct{})
	go func() { w.snapshotLoop(3 * time.Millisecond); close(done) }()

	seen := make(map[string]bool)
	deadline := time.After(200 * time.Millisecond)
gather:
	for {
		select {
		case v := <-ch:
			seen[v.name] = true
			if seen[evNamePollFail] && seen[evNamePollOk] {
				break gather
			}
		case <-deadline:
			break gather
		}
	}
	close(w.stop)
	<-done

	assert.True(t, seen[evNamePollFail], "expected pollfail broadcast during failure streak")
	assert.True(t, seen[evNameStaleWC], "expected stale-wc broadcast on stale snapshot")
	assert.True(t, seen[evNamePollOk], "expected pollok broadcast after stale-interlude + success")
	failed, _ := w.pollStatus()
	assert.False(t, failed, "pollFailed must not remain stuck after stale interlude")
}

func TestHandleEvents_EmitsPollOkOnConnectWhenHealthy(t *testing.T) {
	// Regression: reconnect-resync was asymmetric — only emitted pollfail,
	// never pollok. If polling recovered while SSE was disconnected, the
	// reconnecting client's pollFailError stayed stuck forever. Both branches
	// must emit so reconnect always syncs state.
	for _, tc := range []struct {
		failed  bool
		wantEv  string
		wantErr string // substring for pollfail, empty for pollok
	}{
		{true, "event: pollfail\n", `"error":"blocked"`},
		{false, "event: pollok\ndata: {}", ""},
	} {
		srv := &Server{cachedOp: "some-op"}
		watcher := &Watcher{
			srv:  srv,
			subs: make(map[chan sseEvent]struct{}),
			stop: make(chan struct{}),
		}
		if tc.failed {
			watcher.setPollFail("blocked")
		}

		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
		rec := newSafeRecorder()

		done := make(chan struct{})
		go func() {
			watcher.handleEvents(rec, req)
			close(done)
		}()

		assert.Eventually(t, func() bool {
			return strings.Contains(rec.String(), tc.wantEv)
		}, time.Second, 10*time.Millisecond, "failed=%v", tc.failed)
		if tc.wantErr != "" {
			assert.Contains(t, rec.String(), tc.wantErr, "failed=%v", tc.failed)
		}
		cancel()
		<-done
	}
}

func TestSSHPollLoop_StaleWCSentinel(t *testing.T) {
	// sshPollLoop snapshots (PollOpId without --ignore-working-copy), so it
	// can hit stale-WC. Same sentinel routing as snapshotLoop (shared via
	// probeTracker): broadcast evStaleWC on edge, evFreshWC on recovery.
	// seqRunner can't script errors, so use MockRunner with a stale-WC-
	// matching string (isStaleWCError matches on message content).
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
		t.Fatalf("re-broadcast on repeated stale: %v", v)
	case <-time.After(20 * time.Millisecond):
	}
	assert.True(t, w.stale.Load())

	close(w.stop)
	<-done
}
