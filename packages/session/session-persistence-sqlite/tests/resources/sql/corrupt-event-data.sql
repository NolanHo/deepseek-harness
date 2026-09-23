UPDATE events SET data = ?
WHERE session_id = (SELECT id FROM sessions WHERE session_key = ?) AND seq = ?;
