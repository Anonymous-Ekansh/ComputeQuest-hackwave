# ComputeQuest
**Turn your browser's idle time into real science and a completely private AI host — and get rewarded with an epic card game.**

## What is this?
Imagine if every time you left a tab open on your browser, you were helping scientists discover the next life-saving antibiotic, while simultaneously powering a smart, private AI assistant that lives directly on your computer. That's ComputeQuest.

Searching for new drugs or running Large Language Models (like ChatGPT) usually requires massive, expensive supercomputers. ComputeQuest flips the script: it breaks those massive jobs into tiny pieces and hands them to anyone who opens our website. Your browser quietly does useful science work in the background, and uses its graphics card to run a real AI model locally, without you having to install a single thing.

And because doing science should be fun, we reward you! For every piece of work your browser successfully completes, you earn credits. You can spend those credits in our built-in card game to build a deck and battle bots.

## How it works
Here is what happens behind the scenes while you play:

**1. The Server hands out homework.**
Our central server has a giant list of potential drug candidates. It chops this list into small chunks and sends a chunk to your browser.

**2. Your browser does the math (Drug Screening).**
Your browser runs a real physics-based molecular docking simulation using Webina (a WebAssembly port of AutoDock Vina). It takes the 3D shape of a bacterial target (like a Penicillin-Binding Protein) and tries to fit the candidate molecules into its binding pocket, calculating the exact binding affinity in kcal/mol.

**3. Your browser becomes an AI host (Hackwave LLM).**
While screening drugs, your browser also downloads a powerful AI called TinyLlama using WebLLM technology. When someone asks the ComputeQuest AI a question, the server routes that question to *your* browser. Your graphics card figures out the answer and types it back out in real-time. Because the AI runs on your own hardware, your chats are 100% private and uncensored!

## Project structure
Wondering how this all fits together? Here's where the magic happens:
- **`client/`**: The entire React frontend. This includes the UI, the card game (The Forge), and the powerful background Web Workers that actually run the LLM and the Webina WASM simulations directly in your browser.
- **`server/`**: The Node.js backend. Contains `index.js` (for the API) and `socketHandler.js` (which handles user authentication and routes homework chunks/chat messages to connected browsers).
- **`shared/`**: Contains game logic and constant variables shared by both the client and server.
- **`scripts/`**: Utility scripts, such as the tools used to convert and prep our drug candidate libraries (PDBQT format) before we send them to the browsers.

## What am I actually contributing to?
You are helping screen a massive library of chemical compounds against a real, experimentally-solved 3D structure of an essential bacterial protein. 

> **Important note:** This is a computational estimate (docking), not a certified lab test! Finding a tight binder here doesn't prove a molecule cures a disease. Instead, it narrows down a list of millions of random molecules into a highly-ranked shortlist of candidates worth a real scientist's attention in a physical lab.

## Features
- **Browser-Powered LLM:** Chat with a completely private, uncensored Large Language Model running locally on your own GPU via WebLLM. 
- **Distributed Screening:** Real physical molecular docking (AutoDock Vina) running entirely in your browser. No downloads or installations required.
- **Global Leaderboard:** Track which browser nodes have contributed the most verified work, and view the top molecules discovered by the community based on their binding affinity.
- **The Forge (Card Game):** A full collectible card game built directly into the app to reward you for your compute power.

## The Forge (the game part)
Science pays! As your browser helps compute drug candidates and power the AI, you earn **credits**.

- **Crystals:** Convert your hard-earned credits into crystals.
- **Packs:** Use crystals to buy card packs and unlock unique heroes and spells.
- **Deck Builder:** Assemble your best cards into a powerful deck.
- **Battle Bots:** Test your deck against AI bots to win trophies and climb the Forgemaster Leaderboard!

The battles use a rock-paper-scissors style advantage system. For example, Fire beats Nature, Nature beats Water, and Water beats Fire. Building a balanced deck is the key to victory!

## Tech stack
For the technical folks:

| Component | Technology |
|---|---|
| **Server** | Node.js, Express, Socket.io |
| **Client** | React, Vite |
| **Compute** | Web Workers API, Webina (AutoDock Vina), WebLLM, WebGPU |
| **Database** | Supabase (PostgreSQL) |
| **Auth** | Google OAuth (JWT) |

## Getting started
Want to run the network yourself? Follow these steps:

1. **Clone the repository**
   Open your terminal and run:
   \`\`\`bash
   git clone https://github.com/Anonymous-Ekansh/ComputeQuest-hackwave.git
   cd ComputeQuest-hackwave
   \`\`\`

2. **Set up the environment variables**
   Create a `.env` file in the `/server` folder and another `.env` file in the `/client` folder based on `.env.example`. Here is what you need:
   
   **Server (.env)**
   - `PORT`: Port for the backend server (e.g., 3001).
   - `JWT_SECRET`: Secret string to securely sign user sessions.
   - `SUPABASE_URL`: The URL of your Supabase database project.
   - `SUPABASE_SERVICE_KEY`: The master key to let the server write to the database.
   - `GOOGLE_CLIENT_ID`: Your Google OAuth ID for user logins.
   - `CLIENT_ORIGIN`: The URL where your frontend is running (e.g., http://localhost:5173).

   **Client (.env)**
   - `VITE_SERVER_URL`: The URL of the backend server (so the frontend knows where to connect).
   - `VITE_GOOGLE_CLIENT_ID`: Your Google OAuth ID for rendering the login button.
   - `VITE_MODEL_URL`: Where the app downloads AI models from (defaults to the local server).

3. **Install dependencies and start up**
   Open two terminal windows.
   
   In Terminal 1 (Start the server):
   \`\`\`bash
   cd server
   npm install
   npm run dev
   \`\`\`
   
   In Terminal 2 (Start the client):
   \`\`\`bash
   cd client
   npm install
   npm run dev
   \`\`\`

4. Open `http://localhost:5173` in your browser. Open a second tab to see multiple "nodes" connect and start verifying each other's work!

## Known limitations
- The current drug screening model relies on structural similarity rather than a trained biological classifier. It's a great proxy signal, but shouldn't be treated as medical advice or a definitive cure.
- The built-in LLM AI chat requires a WebGPU-capable browser (like Chrome or Edge) to function properly since it runs completely on your hardware.

## Contributing
We welcome contributions! When submitting changes, please follow these conventions:
- **Branch names**: Use prefixes like `feat/` (for new features), `fix/` (for bug fixes), or `docs/` (for README changes) so we know what kind of work you're doing at a glance.
- **Commit messages**: Write clear, descriptive commit messages (e.g., "fix: resolve scoring crash on mobile") so the project history is easy for everyone to read and understand.
