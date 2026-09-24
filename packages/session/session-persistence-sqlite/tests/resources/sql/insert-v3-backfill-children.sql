-- Frozen historical corpus: one V3 parent with no catalog entries of its own and
-- six direct subagent children that exercise every evidence outcome — an
-- installed-generation descriptor, no descriptor at all, an undecodable
-- compressed payload, a descriptor whose fields the catalog refuses, a child row
-- whose identity this store cannot validate, and a payload that is not a JSON
-- object. Only the descriptor-carrying children own event rows; the parent's
-- backfill is what the V3-to-V4 edge appends.
INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, incarnation, revision)
VALUES
  (1, 'v3-backfill-parent', 3, 2000, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000011', 0),
  (2, 'v3-backfill-continuable', 3, 2001, NULL, 'v3-backfill-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000012', 0),
  (3, 'v3-backfill-silent', 3, 2002, NULL, 'v3-backfill-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000013', 0),
  (4, 'v3-backfill-undecodable', 3, 2003, NULL, 'v3-backfill-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000014', 0),
  (5, 'v3-backfill-invalid-mode', 3, 2004, NULL, 'v3-backfill-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000015', 0),
  (6, 'v3-backfill-unreadable', 3, 2005, NULL, 'v3-backfill-parent', NULL, 'subagent', 'not-a-uuid', 0),
  (7, 'v3-backfill-nonobject', 3, 2006, NULL, 'v3-backfill-parent', NULL, 'subagent', '00000000-0000-4000-8000-000000000017', 0);

INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
VALUES
  (1, 0, 'turn/start', 2011, '{"turn":1}', NULL, NULL, 0),
  (1, 1, 'step/start', 2012, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 2, 'step/end', 2013, '{"turn":1,"step":1}', NULL, NULL, 0),
  (1, 3, 'turn/end', 2014, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
  (2, 0, 'subagent/descriptor', 2021, '{"version":4,"mode":"continuable","provider":"in-process","label":"backfilled child","cwd":"/work/child","skillFilter":{"allow":["review"]}}', NULL, NULL, 0),
  (4, 0, 'subagent/descriptor', 2023, X'DEADBEEF', NULL, NULL, 0),
  (5, 0, 'subagent/descriptor', 2024, '{"version":4,"mode":"sideways","provider":"in-process"}', NULL, NULL, 0),
  (6, 0, 'subagent/descriptor', 2025, '{"version":4,"mode":"one-shot","provider":"in-process"}', NULL, NULL, 0),
  (7, 0, 'subagent/descriptor', 2026, 'null', NULL, NULL, 0);
