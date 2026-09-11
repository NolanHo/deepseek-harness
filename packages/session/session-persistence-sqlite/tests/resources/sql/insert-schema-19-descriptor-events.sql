INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 1, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'step/start', 2, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 2, 'subagent/descriptor', 3, '{"version":4,"mode":"continuable","provider":"in-process","label":"child","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash","cwd":"/work/child","skillFilter":{"allow":["review"]}}', NULL, NULL, 0),
  (1, 3, 'step/end', 4, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 4, 'turn/end', 5, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0);
