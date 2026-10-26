# Neon Cat's Cradle

A webcam toy: MediaPipe Hands tracks both hands and p5.js draws glowing, elastic neon strings between matching fingertips. You can play the strings like an instrument, freeze them into a rotating 3D sculpture, and share the cradle with a friend over WebRTC.

## Run

Camera access needs `localhost` or https, so serve the folder instead of opening the file directly:

```bash
python -m http.server 5173
```

Then open http://localhost:5173 and allow the camera. Click once to enable sound.

## Controls

| Key | Action |
| --- | --- |
| Space | Freeze the current strings into the 3D sculpture |
| Z / Backspace | Undo the last frozen layer |
| X | Clear the sculpture |
| S | Toggle sound |
| M | Multiplayer panel (host a room, or join with a code) |
| C | Clean / CRT mode (hides the video, shows hand silhouettes) |
| H | Hide the HUD |

Touch matching fingertips of both hands together to trigger a particle burst and a chime.

## Structure

| File | What it does |
| --- | --- |
| `index.html` | Page shell, HUD, script loading |
| `js/core.js` | Camera, hand tracking, strings, particles, adaptive quality |
| `js/audio.js` | Web Audio synth: string voices pitched by tension, drone, chimes, plucks |
| `js/sculpture.js` | WebGL renderer for frozen strands, swaying in 3D |
| `js/multiplayer.js` | PeerJS room hosting/joining, hand sync, shared events |

## Performance

- **Adaptive quality.** If the frame rate stays under 24 FPS, the app steps down a tier: the faster MediaPipe model (`modelComplexity` 0), a smaller video frame, no `shadowBlur`, and fewer particles. When the frame rate recovers it steps back up, and it stops retrying for a while if the higher tier keeps failing.
- **Downscaled video.** Each new camera frame is copied once into a canvas 320–640px wide. That copy feeds MediaPipe and is stretched to fill the screen as the background.
- **Particle pool.** Particles are a fixed set of objects that get reused, so bursts don't create new objects or trigger garbage-collection stutter.
- **Cached graphics.** Glow sprites and background layers are drawn once, and only redrawn when the window is resized.

## Multiplayer notes

Multiplayer uses the free public PeerJS broker for signaling and a direct WebRTC data channel for everything else. There is no TURN server, so some strict corporate or symmetric NATs won't connect.
