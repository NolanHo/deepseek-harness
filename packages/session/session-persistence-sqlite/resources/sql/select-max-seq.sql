SELECT COALESCE(MAX(seq), -1) AS stored_end
FROM events
WHERE session_id = ?;
