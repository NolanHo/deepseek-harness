INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
VALUES ((SELECT id FROM sessions WHERE session_key = ?), ?, 'text-chunks', ?, ?, NULL, NULL, 0);
