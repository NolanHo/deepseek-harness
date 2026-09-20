SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
FROM events
ORDER BY session_id, seq;
