INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 1, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'text-chunks', 2, '{"turn":1,"step":1,"index":0,"dt":[1,1],"texts":["a","b","c"]}', NULL, NULL, 1),
  (1, 4, 'turn/end', 5, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0);
