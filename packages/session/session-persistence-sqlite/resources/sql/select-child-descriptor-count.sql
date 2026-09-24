SELECT COUNT(*) AS count
FROM events
WHERE session_id = (SELECT id FROM sessions WHERE session_key = ?)
  AND type = 'subagent/descriptor'
  AND seq >= ?;
