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
- **Local storage** - Recordings saved to IndexedDB for later playback
- **Keyboard shortcut** - Ctrl+Space to stop recording from any tab

## Requirements

- Chrome 116 or later
- Manifest V3

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

After recording, the preview page lets you:

- Play back the recording
- Upload to YouTube (requires Google OAuth2 authorization)
- Upload to a private server
- Rename or delete recordings
- View file metadata (size, resolution, duration)

## Project Structure

```
VigoTechTV/
├── manifest.json                  # Extension manifest (MV3)
├── dropdown.html/js               # Popup UI (start/stop recording)
├── options.html/js                # Settings page
├── preview.html                   # Recording playback & upload
├── preview/
│   ├── preview.js                 # Video player logic
│   ├── preview.php.upload.js      # Private server upload
│   └── preview.youtube.upload.js  # YouTube upload (OAuth2)
├── offscreen.html/js              # Recording engine (media APIs)
├── injected.js                    # Content script API for websites
├── background/
│   ├── service-worker.js          # Main extension logic
│   └── background.contentScript.js # Message bridge (page <-> extension)
├── lib/
│   ├── AudioMixer.js              # WebAudio stream mixer
│   ├── NativeRecorder.js          # MediaRecorder wrapper
│   └── CanvasCompositor.js        # Canvas compositing (PiP + overlays)
├── RecordRTC/
│   └── DiskStorage.js             # IndexedDB storage for recordings
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
Preview (preview.js) → YouTube / Private server
```

The extension uses Chrome's offscreen document API because service workers have no DOM access, while media recording APIs (`getUserMedia`, `MediaRecorder`, `Canvas`) require a document context.

## Author

David Ibañez

## License

MIT
