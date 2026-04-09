export default function handler(req, res) {
  res.json({ status: 'ok', time: new Date().toISOString() });
}
