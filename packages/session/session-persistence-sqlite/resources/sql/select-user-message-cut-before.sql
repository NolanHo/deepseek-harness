SELECT MIN(seq) AS cut
FROM (
  SELECT seq
  FROM events
  WHERE session_id = ? AND type = 'user/message' AND surface_op = '"append"' AND seq < ?
  ORDER BY seq DESC
  LIMIT ?
);
