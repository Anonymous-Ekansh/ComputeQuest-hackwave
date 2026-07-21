export default function handler(req, res) {
  if (req.method === 'POST') {
    const { credential } = req.body;
    res.redirect(`/?token=${credential}`);
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
