# VigoTechTV

Chrome extension for recording meetups with screen, camera and microphone. Supports up to 4K resolution with multiple video codecs (VP8, VP9, H264, MKV).

Built for [VigoTech](https://vigotech.org) community events.

## Features

- **Screen capture** - Record any screen, window or Chrome tab
- **Camera PiP** - Picture-in-Picture overlay of the speaker's camera
- **Logo overlay (mosca)** - Add a custom logo/watermark to recordings
- **Configurable positions** - Choose the corner for both camera PiP and logo
- **Audio mixing** - Combine microphone, system audio and tab audio
- **Multiple codecs** - VP8, VP9, H264, MKV
- **Configurable quality** - Resolution, frame rate and bitrate settings
- **YouTube upload** - Direct upload via OAuth2 (public, unlisted or private)
- **Automatic subtitles** - On-demand speech-to-text with local Whisper (transformers.js, runs in the browser; audio never leaves the device). From the preview, generate subtitles for a recording, download them as .srt/.vtt, and upload them to YouTube as captions. Language and model quality are configurable in Options.
- **Meetup summary (acta)** - Generate a Markdown summary from the transcript: locally with an in-browser LLM (Qwen2.5 via transformers.js; WebGPU when available, WASM otherwise) or via the OpenAI API for higher quality. Produces a summary, key points, mentioned tools and links — ready to publish alongside the video.
- **Local storage** - Recordings saved to IndexedDB for later playback
- **Keyboard shortcut** - Ctrl+Space to stop recording from any tab

## Requirements

- Chrome 116 or later
- Manifest V3
- Subtitles: internet access on first use to download the Whisper model (cached afterwards)

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the project folder
5. The VigoTechTV icon appears in the toolbar

## Usage

### Recording

1. Click the extension icon in the toolbar
2. Select source: **Screen** or **Chrome Tab**
3. Enable options as needed:
   - **Microphone** - Capture presenter audio
   - **Camera** - Show speaker in a PiP overlay
   - **System audio** - Capture audio from the system/tab
4. Click **Start Recording** and select the screen/window to capture
5. Click the icon again or press **Ctrl+Space** to stop
6. The recording opens automatically in the preview page

### Configuration (Options)

Right-click the extension icon and select **Options**, or click "Options" in the popup footer.

| Setting | Description |
|---------|-------------|
| Camera device | Select which camera to use |
| Microphone device | Select which microphone to use |
| Video codec | VP8, VP9, H264, MKV or Default |
| Camera resolution | 240p to 1920p |
| Frame rate | 15, 25 or 30 fps |
| Bitrate | 1 KB/s to 1 GB/s or Default |
| YouTube visibility | Public, Unlisted or Private |
| Logo (mosca) | Upload a PNG/image to overlay on recordings |
| Logo position | Top-left, Top-right, Bottom-left, Bottom-right |
| Logo size | 5%, 8%, 10%, 15% or 20% of canvas width |
| Camera PiP position | Top-left, Top-right, Bottom-left, Bottom-right |

### Preview & Upload

After recording, the preview page opens the **most recent recording** by default and lets you:

- Play back the recording
- **Generate subtitles** with local Whisper (see below)
- Upload to YouTube (requires Google OAuth2 authorization)
- Upload to a private server
- Rename or delete recordings
- View file metadata (size, resolution, duration)

### Subtitles (local Whisper)

Subtitles are generated **on demand from the recorded audio**, not live, and run entirely in the browser with [transformers.js](https://github.com/huggingface/transformers.js) (Whisper on WASM). The audio never leaves the device.

1. Open a recording in the preview page
2. In the **Subtitles** panel (bottom-left), click **Generar subtítulos**
3. The first run downloads the Whisper model (~80 MB for `base`) from the Hugging Face hub and caches it; later runs are offline
4. When done, download the subtitles as **.srt** / **.vtt**, or upload them to YouTube as captions on your next YouTube upload

Language and model quality (`tiny` / `base` / `small`) are configurable in **Options**. Results are cached per recording, so each video is only transcribed once.

> **Note:** Live transcription (Web Speech API) is intentionally not used. During a recording, `getUserMedia` holds the microphone in the offscreen document and Chrome denies `webkitSpeechRecognition` with `not-allowed` (the mic cannot be shared in the same document). Transcribing the recorded audio afterwards avoids the conflict and works for screen, tab and camera recordings alike.

### Meetup summary (local LLM)

Once a recording has subtitles, the **Subtitles** panel also offers **Generar resumen (IA local)**: it feeds the transcript to a small instruct model (Qwen2.5) running locally with transformers.js and produces a Markdown "acta".

- Sections: summary, key points, mentioned tools/projects, links
- **Two providers**, selectable in Options:
  - **Local** (default): Qwen2.5 in-browser, uses WebGPU when available (else WASM); the transcript never leaves the device
  - **OpenAI API**: higher quality; requires your own API key and **sends the transcript to OpenAI**. The key is stored only on this device (`chrome.storage.local`, not synced)
- The local model is downloaded once and cached
- Download the result as **.md** or copy it to the clipboard; results are cached per recording
- Enable/disable, choose provider, local model (0.5B/1.5B) and OpenAI model in **Options**

For long recordings the transcript is summarized in chunks and then consolidated (map-reduce), so quality and speed depend on the chosen model and on whether WebGPU is available.

## Project Structure

```
VigoTechTV/
├── manifest.json                  # Extension manifest (MV3)
├── dropdown.html/js               # Popup UI (start/stop recording)
├── options.html/js                # Settings page
├── preview.html                   # Recording playback & upload
├── preview/
│   ├── preview.js                 # Video player logic (opens newest recording)
│   ├── preview.subtitles.js       # Subtitles + summary panel (generate/download/upload)
│   ├── preview.whisper.js         # Local Whisper transcription (ES module)
│   ├── preview.summary.js         # Local LLM meetup summary (ES module)
│   ├── preview.php.upload.js      # Private server upload
│   └── preview.youtube.upload.js  # YouTube upload (OAuth2) + captions
├── offscreen.html/js              # Recording engine (media APIs)
├── injected.js                    # Content script API for websites
├── background/
│   ├── service-worker.js          # Main extension logic
│   └── background.contentScript.js # Message bridge (page <-> extension)
├── lib/
│   ├── AudioMixer.js              # WebAudio stream mixer
│   ├── NativeRecorder.js          # MediaRecorder wrapper
│   ├── CanvasCompositor.js        # Canvas compositing (PiP + overlays)
│   └── Subtitles.js               # SRT/VTT builders
├── RecordRTC/
│   └── DiskStorage.js             # IndexedDB storage for recordings
├── vendor/                        # Bundled Whisper runtime (transformers.js + ONNX WASM)
└── images/                        # Extension icons
```

## Architecture

```
Popup (dropdown.js)
  │
  ▼
Service Worker (service-worker.js)
  │  - Manages recording state
  │  - Handles desktopCapture / tabCapture
  │  - Reads user config from chrome.storage
  │
  ▼
Offscreen Document (offscreen.js)
  │  - getUserMedia (camera, mic, screen)
  │  - CanvasCompositor (PiP + logo overlay)
  │  - AudioMixer (combine audio streams)
  │  - NativeRecorder (MediaRecorder API)
  │
  ▼
DiskStorage (IndexedDB)
  │
  ▼
Preview (preview.js) ──► YouTube / Private server
  │
  └─► Subtitles (preview.whisper.js)
        - decode recorded audio → 16 kHz mono
        - Whisper (transformers.js / ONNX WASM) in-browser
        - cues → SRT/VTT → download / YouTube captions
```

The extension uses Chrome's offscreen document API because service workers have no DOM access, while media recording APIs (`getUserMedia`, `MediaRecorder`, `Canvas`) require a document context. Subtitle transcription runs in the preview page (not the offscreen document) so it never competes with the recording for the microphone.

## Author

David Ibañez

## License

MIT
