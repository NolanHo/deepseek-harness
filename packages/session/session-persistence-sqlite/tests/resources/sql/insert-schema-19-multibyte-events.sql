-- Frozen schema-19 variant of insert-schema-19-events.sql whose packed text run
-- carries multibyte payloads, so its decoded JSON text separates UTF-8 bytes
-- from UTF-16 code units. Same session row and same physical row layout.
INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 1, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'step/start', 2, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 2, 'text-chunks', 3, '{"turn":1,"step":1,"index":0,"dt":[1,1],"texts":["你好你好你好你好","世界世界世界世界","多字节🙂多字节🙂多字节🙂多字节🙂"]}', NULL, NULL, 1),
  (1, 5, 'step/end', 6, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 6, 'turn/end', 7, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0);
