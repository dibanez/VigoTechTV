// NativeRecorder - Wrapper over native MediaRecorder API

function NativeRecorder(stream, options) {
    var self = this;
    options = options || {};

    var chunks = [];
    var mediaRecorder;

    var mimeType = options.mimeType || selectMimeType(options.audioOnly);

    // Validate the mimeType is actually supported, fall back if not
    if (mimeType && typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mimeType)) {
        console.warn('NativeRecorder: mimeType not supported:', mimeType, '- falling back');
        mimeType = selectMimeType(options.audioOnly);
    }

    function selectMimeType(audioOnly) {
        if (audioOnly) {
            var audioTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
            for (var i = 0; i < audioTypes.length; i++) {
                if (MediaRecorder.isTypeSupported(audioTypes[i])) return audioTypes[i];
            }
            return '';
        }

        var videoTypes = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp8',
            'video/webm'
        ];
        for (var i = 0; i < videoTypes.length; i++) {
            if (MediaRecorder.isTypeSupported(videoTypes[i])) return videoTypes[i];
        }
        return '';
    }

    this.record = function() {
        chunks = [];
        var recorderOptions = {};

        if (mimeType) {
            recorderOptions.mimeType = mimeType;
        }
        if (options.bitsPerSecond) {
            recorderOptions.bitsPerSecond = options.bitsPerSecond;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, recorderOptions);
        } catch (e) {
            console.warn('NativeRecorder: MediaRecorder failed with options, retrying without mimeType:', e);
            try {
                mediaRecorder = new MediaRecorder(stream);
            } catch (e2) {
                console.error('NativeRecorder: MediaRecorder creation failed completely:', e2);
                if (self._errorCallback) self._errorCallback(e2);
                return;
            }
        }

        mediaRecorder.ondataavailable = function(e) {
            if (e.data && e.data.size > 0) {
                chunks.push(e.data);
            }
        };

        mediaRecorder.onstop = function() {
            var blobType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || 'video/webm';
            self.blob = new Blob(chunks, { type: blobType });
            chunks = [];
            if (self._stopCallback) {
                self._stopCallback();
                self._stopCallback = null;
            }
        };

        mediaRecorder.onerror = function(event) {
            console.error('NativeRecorder: MediaRecorder error:', event.error || event);
            if (self._errorCallback) self._errorCallback(event.error || event);
        };

        mediaRecorder.start(1000);
    };

    this.stop = function(callback) {
        // If the recorder already stopped on its own (e.g. the screen track ended
        // when the user stopped sharing), onstop may not have run with a callback.
        // Make sure a blob is assembled from whatever chunks were captured.
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            if (!self.blob) {
                var blobType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || 'video/webm';
                self.blob = new Blob(chunks, { type: blobType });
                chunks = [];
            }
            if (callback) callback();
            return;
        }

        self._stopCallback = callback;
        mediaRecorder.stop();
    };

    this.pause = function() {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.pause();
        }
    };

    this.resume = function() {
        if (mediaRecorder && mediaRecorder.state === 'paused') {
            mediaRecorder.resume();
        }
    };

    this.onError = function(callback) {
        self._errorCallback = callback;
    };

    this.blob = null;
    this.streams = [stream];
}
