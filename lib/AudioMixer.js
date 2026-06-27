// AudioMixer - Mixes audio from multiple MediaStreams via WebAudio API

function AudioMixer() {
    var context = new AudioContext();
    var sources = [];
    var gainNode = context.createGain();
    var destination = context.createMediaStreamDestination();

    // Don't play audio through speakers (avoid echo)
    gainNode.connect(context.destination);
    gainNode.gain.value = 0;

    // AudioContext may start suspended in offscreen documents
    if (context.state === 'suspended') {
        context.resume();
    }

    // Mix audio from an array of MediaStreams
    // Returns a MediaStream with mixed audio, or null if no audio tracks found
    this.mix = function(mediaStreams) {
        var hasAudio = false;

        mediaStreams.forEach(function(stream) {
            if (!stream.getAudioTracks().length) return;
            hasAudio = true;

            var source = context.createMediaStreamSource(stream);
            source.connect(gainNode);
            source.connect(destination);
            sources.push(source);
        });

        if (!hasAudio) return null;

        return destination.stream;
    };

    this.destroy = function() {
        sources.forEach(function(source) {
            try { source.disconnect(); } catch (e) {}
        });
        sources = [];

        try { gainNode.disconnect(); } catch (e) {}
        try { destination.disconnect(); } catch (e) {}

        if (context.state !== 'closed') {
            context.close();
        }
    };
}
