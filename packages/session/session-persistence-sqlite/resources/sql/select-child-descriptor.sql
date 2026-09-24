SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
FROM events
WHERE session_id = (SELECT id FROM sessions WHERE session_key = ?)
  AND type = 'subagent/descriptor'
  AND seq >= ?
ORDER BY seq
LIMIT 1;
