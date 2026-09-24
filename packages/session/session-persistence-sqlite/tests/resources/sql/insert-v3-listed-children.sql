-- Frozen historical corpus: one V3 parent whose two direct subagent children are
-- both listed in its own catalog, so the V3-to-V4 edge retains those entries.
-- The child rows carry the version-4 descriptor the installed subagent package
-- writes, which is what the parent's evidence collection reads. Two further rows
-- carry descriptors but are not this parent's direct subagent children — one
-- names another parent and one has no subagent origin — so neither may backfill.
INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, incarnation, revision)
VALUES
  (1, 'v3-listed-parent', 3, 1000, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000001', 0),
  (2, 'v3-listed-continuable', 3, 1001, NULL, 'v3-listed-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000002', 0),
  (3, 'v3-listed-silent', 3, 1002, NULL, 'v3-listed-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000003', 0),
  (4, 'v3-listed-elsewhere', 3, 1003, NULL, 'v3-listed-other-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000004', 0),
  (5, 'v3-listed-forked', 3, 1004, NULL, 'v3-listed-parent', NULL, NULL, '00000000-0000-4000-8000-000000000005', 0);

INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 1011, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'step/start', 1012, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 2, 'step/end', 1013, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 3, 'turn/end', 1014, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
  (1, 4, 'subagent/catalog', 1015, '{"version":0,"childId":"v3-listed-continuable","childCreatedAt":1001,"mode":"continuable","label":"listed child"}', NULL, NULL, 0),
  (1, 5, 'subagent/catalog', 1016, '{"version":1,"childId":"v3-listed-silent","childCreatedAt":1002,"mode":"unknown"}', NULL, NULL, 0),
  (2, 0, 'subagent/descriptor', 1021, '{"version":4,"mode":"continuable","provider":"in-process","label":"listed child","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash","cwd":"/work/child","skillFilter":{"allow":["review"]}}', NULL, NULL, 0),
  (4, 0, 'subagent/descriptor', 1023, '{"version":4,"mode":"continuable","provider":"in-process","label":"elsewhere child"}', NULL, NULL, 0),
  (5, 0, 'subagent/descriptor', 1024, '{"version":4,"mode":"continuable","provider":"in-process","label":"forked child"}', NULL, NULL, 0);
