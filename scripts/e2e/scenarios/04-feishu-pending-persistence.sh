#!/usr/bin/env bash
# Scenario 04: The DB-backed Feishu pending-message table survives a server
# restart and the replay loop runs on boot. Since we don't have a real Lark
# WebSocket in CI, we verify: (a) seeded rows remain after restart, (b) the
# replay log fires, and (c) rows whose connection is not restored are left in
# place for a later retry.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
e2e::setup

MSG_ID="msg_e2e_pending_$$"
# A second Agent in the same Feishu group. Feishu delivers one message_id to
# every bot in a chat, so both Agents must be able to hold a row for it.
SECOND_AGENT_ID="agt_e2e_hardening_2"

e2e::sql "
  INSERT INTO agents (
    id, name, description, type, config, status, icon,
    skills, mcp_server_ids, kb_document_ids,
    max_concurrency, publish_status, user_id,
    created_at, updated_at
  ) VALUES (
    '$SECOND_AGENT_ID', 'E2E Hardening 2', 'second bot in the same group', 'cursor', '{}', 'active', '🧪',
    '[]', '[]', '[]',
    1, 'published', 'usr_e2e',
    unixepoch(), unixepoch()
  );
"

e2e::sql "
  INSERT INTO feishu_pending_messages (message_id, agent_id, run_id, payload, created_at)
    VALUES ('$MSG_ID', '$E2E_AGENT_ID', NULL,
      json_object('message', json_object('message_id', '$MSG_ID', 'chat_id', 'chat_1', 'message_type', 'text', 'content', '{\"text\":\"hi\"}'),
                  'sender', json_object('sender_id', json_object('open_id', 'usr_e2e'))),
      unixepoch() * 1000);
"

# The SAME message_id for the second Agent must be storable. Under the old
# message_id-only primary key this insert failed outright, which is exactly how
# the second Agent lost the message in production.
e2e::sql "
  INSERT INTO feishu_pending_messages (message_id, agent_id, run_id, payload, created_at)
    VALUES ('$MSG_ID', '$SECOND_AGENT_ID', NULL,
      json_object('message', json_object('message_id', '$MSG_ID', 'chat_id', 'chat_1', 'message_type', 'text', 'content', '{\"text\":\"hi\"}'),
                  'sender', json_object('sender_id', json_object('open_id', 'usr_e2e'))),
      unixepoch() * 1000);
"

PAIR_COUNT="$(e2e::sql "SELECT count(*) FROM feishu_pending_messages WHERE message_id = '$MSG_ID';")"
e2e::assert_eq "$PAIR_COUNT" "2" "same message_id stored once per Agent (composite PK)"

e2e::start_api

# Row is preserved when the Feishu connection cannot be rebuilt (no creds in CI).
# The replay loop should log completion and leave the row for the next restart.
ROW_COUNT="$(e2e::sql "SELECT count(*) FROM feishu_pending_messages WHERE message_id = '$MSG_ID';")"
e2e::assert_eq "$ROW_COUNT" "2" "both Agents' pending rows preserved when no connection available"

e2e::log_contains 'Feishu pending message replay completed' \
  || e2e::fail "expected 'Feishu pending message replay completed' log line"

SKIPPED_COUNT="$(e2e::log_json_field 'Feishu pending message replay completed' 'skipped')"
e2e::assert_eq "$SKIPPED_COUNT" "2" "replay skipped == 2 (one per Agent; no Lark connection in CI)"

e2e::stop_api
