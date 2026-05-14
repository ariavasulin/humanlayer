# Implementation Plan

## Overview

When a session is created, fire an async LLM call via the internal Anthropic proxy to generate a concise, descriptive summary from the query, replacing the naive 50-rune truncation. Silent fallback to the truncated summary on any failure.

## Phase 1: Core function + LaunchSession integration

### Changes

#### 1. Add `generateSummaryAsync` to manager.go

**File**: `hld/session/manager.go`
**Action**: modify — add new imports and new function

**New imports** (add to existing import block):

```go
"bytes"
"io"
"net/http"
```

**New function** — insert after `SetHTTPPort` (after line 105):

```go
// generateSummaryAsync spawns a goroutine that calls the Anthropic proxy to generate
// a concise session summary from the query. On any failure, the existing truncated
// summary is left in place. Uses context.Background() because this outlives the
// caller's request context.
func (m *Manager) generateSummaryAsync(sessionID string, query string) {
	m.mu.RLock()
	port := m.httpPort
	m.mu.RUnlock()
	if port == 0 {
		slog.Debug("skipping summary generation, HTTP server not ready", "session_id", sessionID)
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		reqBody, err := json.Marshal(map[string]interface{}{
			"model":      "claude-haiku-4-5-20241022",
			"max_tokens": 50,
			"system":     "Generate a concise session title (under 50 characters) for the following user query. Output only the title, no quotes, no punctuation at the end.",
			"messages": []map[string]string{
				{"role": "user", "content": query},
			},
		})
		if err != nil {
			slog.Debug("failed to marshal summary request", "session_id", sessionID, "error", err)
			return
		}

		url := fmt.Sprintf("http://localhost:%d/api/v1/anthropic_proxy/%s/v1/messages", port, sessionID)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
		if err != nil {
			slog.Debug("failed to create summary request", "session_id", sessionID, "error", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("anthropic-version", "2023-06-01")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			slog.Debug("summary generation request failed", "session_id", sessionID, "error", err)
			return
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != 200 {
			slog.Debug("summary generation returned non-200", "session_id", sessionID, "status", resp.StatusCode)
			return
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			slog.Debug("failed to read summary response", "session_id", sessionID, "error", err)
			return
		}

		var result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			slog.Debug("failed to parse summary response", "session_id", sessionID, "error", err)
			return
		}
		if len(result.Content) == 0 || strings.TrimSpace(result.Content[0].Text) == "" {
			slog.Debug("summary response had no content", "session_id", sessionID)
			return
		}

		summary := strings.TrimSpace(result.Content[0].Text)
		if err := m.store.UpdateSession(ctx, sessionID, store.SessionUpdate{Summary: &summary}); err != nil {
			slog.Debug("failed to update session summary", "session_id", sessionID, "error", err)
			return
		}

		if m.eventBus != nil {
			m.eventBus.Publish(bus.Event{
				Type: bus.EventSessionStatusChanged,
				Data: map[string]interface{}{
					"session_id": sessionID,
				},
			})
		}

		slog.Debug("session summary generated", "session_id", sessionID, "summary", summary)
	}()
}
```

**Design notes**:
- Uses `context.Background()` not the caller's ctx — this goroutine must outlive the HTTP request that triggered `LaunchSession`. The hld CLAUDE.md says goroutines should accept `context.Context`, but passing the caller's ctx would cancel the LLM call when `LaunchSession` returns. `monitorSession` accepts ctx but handles cancellation as a signal to stop; here there's nothing to stop gracefully — the 5s timeout is the only bound.
- The httpPort==0 guard runs BEFORE spawning the goroutine to avoid pointless goroutine creation.
- Event data only includes `session_id` (no `old_status`/`new_status`) because the status hasn't changed — only the summary. The SSE handler in `useSubscriptions.ts:19-135` re-fetches the full session object on `session_status_changed`, so it will pick up the new summary regardless of what's in the event data.

#### 2. Wire into LaunchSession

**File**: `hld/session/manager.go`
**Action**: modify — add one line after `CreateSession` call

Insert after line 369 (after the `CreateSession` error check block closes):

```go
	m.generateSummaryAsync(sessionID, claudeConfig.Query)
```

Placement: immediately after the `CreateSession` call succeeds and before `StoreMCPServers`. The session must exist in the DB before the proxy call because `handleNonStreamingProxy` calls `h.store.GetSession` at `proxy.go:225`.

### Verification

#### Automated
- [x] `cd hld && go build ./...` — compiles with new imports and function
- [x] `cd hld && go vet ./...` — no issues
- [x] `cd hld && make test-unit-quiet` — existing tests pass (no new tests in this phase; the function is fire-and-forget with no observable return value outside of DB state)

#### Manual
- [ ] Start daemon with `ANTHROPIC_API_KEY` set. Create a session with a long query. Check WUI session table — summary should update from truncated to LLM-generated within ~1s.
- [ ] Start daemon without `ANTHROPIC_API_KEY`. Create a session. The proxy will return a non-200 (auth failure). The truncated summary should persist. Check daemon logs at debug level — should see `"summary generation returned non-200"`.
- [ ] Verify no goroutine leak: create 5 sessions rapidly, wait 10s, check daemon memory is stable.

---

## Phase 2: ContinueSession + LaunchDraftSession call sites

### Changes

#### 1. Wire into ContinueSession

**File**: `hld/session/manager.go`
**Action**: modify — add one line

Insert after line 1669 (after the `CreateSession` error check block in `ContinueSession` closes):

```go
	m.generateSummaryAsync(sessionID, req.Query)
```

#### 2. Wire into LaunchDraftSession

**File**: `hld/session/manager.go`
**Action**: modify — add one line

Insert after line 2162 (after the `UpdateSession` error check block in `LaunchDraftSession` closes):

```go
	m.generateSummaryAsync(sessionID, prompt)
```

### Verification

#### Automated
- [ ] `cd hld && go build ./...` — compiles
- [ ] `cd hld && make test-unit-quiet` — passes

#### Manual
- [ ] Fork a session (triggers `ContinueSession`). Child session should get its own LLM summary, independent of parent's summary.
- [ ] Create a draft session, then launch it. Summary should update from truncated to LLM-generated.
- [ ] Verify all three paths produce summaries by checking DB: `sqlite3 ~/.humanlayer/daemon-dev.db "SELECT id, substr(summary,1,60) FROM sessions ORDER BY created_at DESC LIMIT 5;"`
