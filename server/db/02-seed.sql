-- Sample data. Safe to run repeatedly.
INSERT INTO users (name, email)
VALUES
  ('Ada Lovelace', 'ada@example.com'),
  ('Alan Turing', 'alan@example.com')
ON CONFLICT (email) DO NOTHING;
