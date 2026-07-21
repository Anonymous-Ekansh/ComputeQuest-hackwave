export default function handler(req, res) {
  if (req.method === 'POST') {
    const { credential } = req.body;
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Logging in...</title>
      </head>
      <body>
        <script>
          localStorage.setItem('cq_auth_token_temp', '${credential}');
          window.location.href = '/';
        </script>
      </body>
      </html>
    `);
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
