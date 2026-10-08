# Snake × Jev

Snake played by [TypeSafe](https://typesafe.ai)'s **Jev** model, with a live panel that shows every call to Jev: the state sent, the question asked, and Jev's answer with its probabilities.

## How Jev plays

Each turn, code tells Jev only what the snake observes, with no hints about which move is safe or good:

- **`what_the_snake_sees`**: what lies in each allowed direction from the head, e.g. `"3 empty squares, then the wall"` or `"the snake's own body, directly next to the head"`
- **`food`**: where the food is relative to the head, e.g. `"The food is 4 squares up and 2 squares to the right from the head."`

Jev answers one `choice` question (*"Which direction should the snake move next to achieve `goal`?"*), and its chosen move is applied as-is. Code never overrides it. The option order is shuffled every turn. Reversing into the snake's neck isn't allowed in Snake, so that direction is never offered.

## Run it

Requires Node 18+. There are no dependencies to install.

```sh
cp .env.example .env   # then set TYPESAFE_API_KEY in .env
npm start              # http://localhost:3000
```

The API key stays on the server (`server.js` proxies calls to `https://api.typesafe.ai/v1/systemone`). Temporary API errors (`model_unavailable`, 429, 5xx) are retried automatically, and retried calls are labeled in the panel.

## Controls

- **Jev drives / I drive**: let Jev play, or steer with the arrow keys
- **Start / Pause** (Space), **Step** (one Jev decision), **Reset**
- **Pause after each move**: slows the game down for an audience
- **Download JSON**: the exact request and response for every call
