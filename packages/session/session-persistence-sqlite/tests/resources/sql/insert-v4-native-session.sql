-- Frozen current-format corpus: one V4 parent with a direct subagent child. A
-- current-format row restores natively, so its children are never collected;
-- the child row exists to prove that.
INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, incarnation, revision)
VALUES
  (1, 'v4-native-parent', 4, 3000, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000021', 0),
  (2, 'v4-native-child', 4, 3001, NULL, 'v4-native-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000022', 0);

INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 3011, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'step/start', 3012, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 2, 'step/end', 3013, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 3, 'turn/end', 3014, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
  (2, 0, 'subagent/descriptor', 3021, '{"version":4,"mode":"one-shot","provider":"in-process","label":"native child"}', NULL, NULL, 0);
