// CanvasCompositor - Composites multiple video streams via Canvas
//
// Designed for Chrome extension offscreen documents where:
// - <video> elements do NOT decode frames (no visible rendering surface)
// - canvas.captureStream() produces EMPTY frames (Chromium bugs 41270855, 40671698)
// - requestAnimationFrame never fires
//
// Solution:
// INPUT:  MediaStreamTrackProcessor reads raw VideoFrame from each track
// DRAW:   drawImage(VideoFrame) renders onto a 2D canvas
// OUTPUT: MediaStreamTrackGenerator produces the output MediaStreamTrack
//         (bypasses captureStream entirely)
//
// Requirements: Chrome 94+ (MediaStreamTrackProcessor, MediaStreamTrackGenerator)

function CanvasCompositor() {
    var self = this;
    var canvas = document.createElement('canvas');
    var context = canvas.getContext('2d');
    var entries = [];
    var imageEntries = [];
    var bgColor = null;
    var running = false;
    var drawInterval = null;
    var drawCount = 0;

    // Output via MediaStreamTrackGenerator
    var generator = null;
    var writer = null;
    var writeReady = true;
    var startTime = 0;

    canvas.style.cssText = 'position:absolute;z-index:-1;top:-10000px;left:-10000px;';
    (document.body || document.documentElement).appendChild(canvas);

    // Fill the canvas with a solid colour each frame (used by the "framed"
    // no-overlap layout to give the letterbox area a clean background).
    this.setBackground = function(color) {
        bgColor = color;
    };

    // Add a stream to composite
    // layout: { fullCanvas: bool, x, y, width, height, fit }
    //   fit: 'contain' draws the frame scaled to fit inside x/y/width/height
    //        preserving aspect ratio (centred); otherwise it's stretched.
    this.addStream = function(stream, layout) {
        layout = layout || {};

        var videoTrack = stream.getVideoTracks()[0];
        var label = layout.fullCanvas ? 'screen' : 'camera';

        var entry = {
            stream: stream,
            latestFrame: null,
            reader: null,
            fullCanvas: !!layout.fullCanvas,
            fit: layout.fit || null,
            x: layout.x || 0,
            y: layout.y || 0,
            width: layout.width || 0,
            height: layout.height || 0
        };

        if (videoTrack && typeof MediaStreamTrackProcessor !== 'undefined') {
            var processor = new MediaStreamTrackProcessor({ track: videoTrack });
            var reader = processor.readable.getReader();
            entry.reader = reader;

            function readFrame() {
                reader.read().then(function(result) {
                    if (result.done) {
                        console.log('CanvasCompositor: reader done (' + label + ')');
                        return;
                    }
                    var oldFrame = entry.latestFrame;
                    entry.latestFrame = result.value;
                    if (oldFrame) oldFrame.close();
                    readFrame();
                }).catch(function(e) {
                    if (running) {
                        console.warn('CanvasCompositor: frame read error (' + label + '):', e.message);
                    }
                });
            }
            readFrame();
            console.log('CanvasCompositor: addStream (' + label + ') via TrackProcessor');
        } else {
            console.warn('CanvasCompositor: no video track or TrackProcessor unavailable (' + label + ')');
        }

        entries.push(entry);
        return entry;
    };

    // Add a static image overlay (logo/watermark)
    // image: HTMLImageElement or ImageBitmap
    // layout: { x, y, width, height }
    this.addImage = function(image, layout) {
        layout = layout || {};
        var imgEntry = {
            image: image,
            x: layout.x || 0,
            y: layout.y || 0,
            width: layout.width || image.width || 100,
            height: layout.height || image.height || 100
        };
        imageEntries.push(imgEntry);
        console.log('CanvasCompositor: addImage at ' + imgEntry.x + ',' + imgEntry.y +
            ' size=' + imgEntry.width + 'x' + imgEntry.height);
        return imgEntry;
    };

    // Start compositing, returns a MediaStream with the composited video
    this.start = function(width, height) {
        canvas.width = width || 1920;
        canvas.height = height || 1080;
        running = true;
        drawCount = 0;
        startTime = performance.now();

        console.log('CanvasCompositor: start canvas=' + canvas.width + 'x' + canvas.height +
            ' entries=' + entries.length);

        var outputStream;

        // Primary: MediaStreamTrackGenerator (bypasses broken captureStream)
        if (typeof MediaStreamTrackGenerator !== 'undefined') {
            generator = new MediaStreamTrackGenerator({ kind: 'video' });
            writer = generator.writable.getWriter();
            outputStream = new MediaStream([generator]);
            console.log('CanvasCompositor: output via MediaStreamTrackGenerator');
        } else {
            // Fallback: captureStream (likely broken in offscreen but try)
            console.warn('CanvasCompositor: MediaStreamTrackGenerator not available, falling back to captureStream');
            if ('captureStream' in canvas) {
                outputStream = canvas.captureStream(30);
            } else if ('mozCaptureStream' in canvas) {
                outputStream = canvas.mozCaptureStream(30);
            }
        }

        if (!outputStream) {
            console.error('CanvasCompositor: no output method available');
            return null;
        }

        // Draw loop at ~30fps
        drawInterval = setInterval(function() {
            if (running) draw();
        }, 33);

        return outputStream;
    };

    function draw() {
        if (!running) return;

        drawCount++;
        var drewSomething = false;

        // Clean background (letterbox bars in framed layout)
        if (bgColor) {
            context.fillStyle = bgColor;
            context.fillRect(0, 0, canvas.width, canvas.height);
        }

        // Draw fullCanvas entries first (screen = background)
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].fullCanvas) continue;
            if (!entries[i].latestFrame) continue;
            try {
                context.drawImage(entries[i].latestFrame, 0, 0, canvas.width, canvas.height);
                drewSomething = true;
            } catch (e) {
                if (drawCount <= 5) console.warn('CanvasCompositor: draw screen error:', e.message);
            }
        }

        // Draw overlay entries (camera PiP) on top
        for (var j = 0; j < entries.length; j++) {
            if (entries[j].fullCanvas) continue;
            if (!entries[j].latestFrame) continue;
            var frame = entries[j].latestFrame;
            try {
                if (entries[j].fit === 'contain') {
                    // Scale to fit inside the box, preserving aspect ratio, centred.
                    var srcW = frame.displayWidth || frame.codedWidth || entries[j].width || 320;
                    var srcH = frame.displayHeight || frame.codedHeight || entries[j].height || 240;
                    var bw = entries[j].width || srcW;
                    var bh = entries[j].height || srcH;
                    var scale = Math.min(bw / srcW, bh / srcH);
                    var dw = srcW * scale;
                    var dh = srcH * scale;
                    var dx = entries[j].x + (bw - dw) / 2;
                    var dy = entries[j].y + (bh - dh) / 2;
                    context.drawImage(frame, dx, dy, dw, dh);
                } else {
                    var w = entries[j].width || frame.displayWidth || 320;
                    var h = entries[j].height || frame.displayHeight || 240;
                    context.drawImage(frame, entries[j].x, entries[j].y, w, h);
                }
                drewSomething = true;
            } catch (e) {
                if (drawCount <= 5) console.warn('CanvasCompositor: draw camera error:', e.message);
            }
        }

        // Draw static image overlays (logo) on top of everything
        for (var k = 0; k < imageEntries.length; k++) {
            try {
                context.drawImage(imageEntries[k].image,
                    imageEntries[k].x, imageEntries[k].y,
                    imageEntries[k].width, imageEntries[k].height);
                drewSomething = true;
            } catch (e) {
                if (drawCount <= 5) console.warn('CanvasCompositor: draw image error:', e.message);
            }
        }

        // Write composited frame to output track
        if (drewSomething && writer && writeReady) {
            writeReady = false;
            try {
                var timestamp = Math.round((performance.now() - startTime) * 1000); // microseconds
                var frame = new VideoFrame(canvas, { timestamp: timestamp });
                writer.write(frame).then(function() {
                    writeReady = true;
                }).catch(function(e) {
                    writeReady = true;
                    if (drawCount <= 5) console.warn('CanvasCompositor: write error:', e.message);
                });
                frame.close(); // write() captures data synchronously
            } catch (e) {
                writeReady = true;
                if (drawCount <= 5) console.warn('CanvasCompositor: VideoFrame error:', e.message);
            }
        }

        // Diagnostic log
        if (drawCount <= 5 || drawCount % 300 === 0) {
            var info = entries.map(function(e) {
                var tag = e.fullCanvas ? 'SCR' : 'CAM';
                if (e.latestFrame) {
                    return tag + ':' + e.latestFrame.displayWidth + 'x' + e.latestFrame.displayHeight;
                }
                return tag + ':waiting';
            });
            imageEntries.forEach(function(img) {
                info.push('IMG:' + img.width + 'x' + img.height);
            });
            console.log('CanvasCompositor draw #' + drawCount +
                ' drew=' + drewSomething + ' [' + info.join(' | ') + ']');
        }
    }

    this.stop = function() {
        running = false;
        if (drawInterval) {
            clearInterval(drawInterval);
            drawInterval = null;
        }
        if (writer) {
            writer.close().catch(function() {});
            writer = null;
        }
        console.log('CanvasCompositor: stopped after ' + drawCount + ' draws');
    };

    this.destroy = function() {
        self.stop();

        entries.forEach(function(entry) {
            if (entry.latestFrame) {
                entry.latestFrame.close();
                entry.latestFrame = null;
            }
            if (entry.reader) {
                entry.reader.cancel().catch(function() {});
                entry.reader = null;
            }
        });
        entries = [];
        imageEntries = [];

        context.clearRect(0, 0, canvas.width, canvas.height);
        if (canvas.parentNode) {
            canvas.parentNode.removeChild(canvas);
        }
    };

    this.canvas = canvas;
}
