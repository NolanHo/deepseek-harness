UPDATE events
SET data = '{not json'
WHERE session_id = (SELECT id FROM sessions WHERE session_key = ?)
  AND type = 'text-chunks';
