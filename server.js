const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const VALID_STATUSES = ['backlog', 'in-progress', 'complete'];

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./clients.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    db.run('ALTER TABLE clients ADD COLUMN priority INTEGER DEFAULT 999', () => {
      // Ignore error if column already exists
      db.all('SELECT id, status, priority FROM clients ORDER BY id ASC', (selectErr, rows) => {
        if (!selectErr && Array.isArray(rows)) {
          VALID_STATUSES.forEach((st) => {
            const laneRows = rows
              .filter((r) => (r.status || 'backlog') === st)
              .sort((a, b) => (a.priority || 999) - (b.priority || 999) || a.id - b.id);
            laneRows.forEach((row, idx) => {
              db.run('UPDATE clients SET priority = ? WHERE id = ?', [idx + 1, row.id]);
            });
          });
        }
      });
    });
  }
});

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Re-indexes priorities 1..N for a given status column
async function reindexLane(status, orderedIds) {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await dbRun('UPDATE clients SET status = ?, priority = ? WHERE id = ?', [
      status,
      i + 1,
      orderedIds[i],
    ]);
  }
}

// Moves/reorders a client card across or within swimlanes
async function updateClientPosition(clientId, nextStatus, nextPriority) {
  const numericId = Number(clientId);
  const client = await dbGet('SELECT * FROM clients WHERE id = ?', [numericId]);
  if (!client) return null;

  const oldStatus = VALID_STATUSES.includes(client.status) ? client.status : 'backlog';
  const targetStatus = VALID_STATUSES.includes(nextStatus) ? nextStatus : oldStatus;

  const oldLaneRows = await dbAll(
    'SELECT id FROM clients WHERE status = ? AND id != ? ORDER BY priority ASC, id ASC',
    [oldStatus, numericId]
  );
  const oldRemainingIds = oldLaneRows.map((r) => r.id);

  if (oldStatus !== targetStatus) {
    await reindexLane(oldStatus, oldRemainingIds);

    const targetLaneRows = await dbAll(
      'SELECT id FROM clients WHERE status = ? AND id != ? ORDER BY priority ASC, id ASC',
      [targetStatus, numericId]
    );
    const targetIds = targetLaneRows.map((r) => r.id);
    const insertIdx =
      typeof nextPriority === 'number' && !Number.isNaN(nextPriority)
        ? Math.max(0, Math.min(nextPriority - 1, targetIds.length))
        : targetIds.length;

    targetIds.splice(insertIdx, 0, numericId);
    await reindexLane(targetStatus, targetIds);
  } else {
    const insertIdx =
      typeof nextPriority === 'number' && !Number.isNaN(nextPriority)
        ? Math.max(0, Math.min(nextPriority - 1, oldRemainingIds.length))
        : oldRemainingIds.length;

    oldRemainingIds.splice(insertIdx, 0, numericId);
    await reindexLane(oldStatus, oldRemainingIds);
  }

  return dbGet('SELECT * FROM clients WHERE id = ?', [numericId]);
}

// GET all clients (optionally filtered by ?status=...)
app.get('/api/v1/clients', async (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? await dbAll('SELECT * FROM clients WHERE status = ? ORDER BY priority ASC, id ASC', [status])
      : await dbAll('SELECT * FROM clients ORDER BY priority ASC, id ASC');
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update client status and/or priority
app.put('/api/v1/clients/:id', async (req, res) => {
  try {
    const { status, priority } = req.body || {};
    const parsedPriority =
      priority !== undefined && priority !== null ? Number(priority) : undefined;

    const updated = await updateClientPosition(req.params.id, status, parsedPriority);
    if (!updated) {
      return res.status(404).json({ error: 'Client not found' });
    }
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
