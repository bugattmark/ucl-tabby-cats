class VoiceTranslator {
    constructor() {
        this.recordBtn = document.getElementById('recordBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.thaiText = document.getElementById('thaiText');
        this.translatedText = document.getElementById('translatedText');
        this.status = document.getElementById('status');
        this.errorDiv = document.getElementById('error');
        this.waveform = document.getElementById('waveform');

        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioContext = null;
        this.analyser = null;
        this.sonioxWs = null;
        this.audioQueue = [];
        this.isPlayingAudio = false;
        this.currentThaiText = '';
        this.currentTranslation = '';

        this.initWaveform();
        this.attachEventListeners();
    }

    initWaveform() {
        for (let i = 0; i < 20; i++) {
            const bar = document.createElement('div');
            bar.className = 'bar';
            this.waveform.appendChild(bar);
        }
    }

    attachEventListeners() {
        this.recordBtn.addEventListener('click', () => this.toggleRecording());
        this.clearBtn.addEventListener('click', () => this.clearAll());
        this.stopBtn.addEventListener('click', () => this.stopAll());
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            this.showStatus('Initializing...', true);
            this.clearError();

            // Get microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            // Set up audio context for visualization
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            const source = this.audioContext.createMediaStreamSource(stream);
            source.connect(this.analyser);
            this.analyser.fftSize = 64;
            this.visualize();

            // Connect to Soniox WebSocket
            await this.connectSoniox(stream);

            this.isRecording = true;
            this.recordBtn.classList.add('recording');
            this.recordBtn.textContent = '⏹️';
            this.stopBtn.style.display = 'block';
            this.showStatus('Listening... Speak in Thai', true);

        } catch (error) {
            console.error('Error starting recording:', error);
            this.showError('Failed to start recording: ' + error.message);
        }
    }

    async connectSoniox(stream) {
        return new Promise((resolve, reject) => {
            // Connect to our backend which will proxy to Soniox
            this.sonioxWs = new WebSocket('ws://localhost:3000/soniox');

            this.sonioxWs.onopen = () => {
                console.log('Soniox WebSocket connected');

                // Start sending audio
                this.startAudioStream(stream);
                resolve();
            };

            this.sonioxWs.onmessage = async (event) => {
                const data = JSON.parse(event.data);

                if (data.type === 'transcript') {
                    const text = data.text;
                    this.currentThaiText = text;
                    this.thaiText.textContent = text;

                    // Send to translation immediately
                    if (text && text.length > 0) {
                        await this.translateAndSpeak(text);
                    }
                } else if (data.type === 'error') {
                    this.showError('Soniox error: ' + data.message);
                }
            };

            this.sonioxWs.onerror = (error) => {
                console.error('Soniox WebSocket error:', error);
                reject(error);
            };

            this.sonioxWs.onclose = () => {
                console.log('Soniox WebSocket closed');
            };
        });
    }

    startAudioStream(stream) {
        const mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus'
        });

        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && this.sonioxWs?.readyState === WebSocket.OPEN) {
                // Convert to required format and send
                const arrayBuffer = await event.data.arrayBuffer();
                this.sonioxWs.send(arrayBuffer);
            }
        };

        // Send audio chunks every 100ms for real-time processing
        mediaRecorder.start(100);
        this.mediaRecorder = mediaRecorder;
    }

    async translateAndSpeak(thaiText) {
        try {
            // Call our backend to translate using Gemini Flash 2.5 with streaming
            const response = await fetch('http://localhost:3000/translate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: thaiText })
            });

            if (!response.ok) throw new Error('Translation failed');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let translatedChunk = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const json = JSON.parse(data);
                            if (json.token) {
                                translatedChunk += json.token;
                                this.currentTranslation = translatedChunk;
                                this.translatedText.textContent = translatedChunk;

                                // Send token to TTS for immediate playback
                                this.speakToken(json.token);
                            }
                        } catch (e) {
                            // Skip invalid JSON
                        }
                    }
                }
            }

        } catch (error) {
            console.error('Translation error:', error);
            this.showError('Translation failed: ' + error.message);
        }
    }

    async speakToken(token) {
        try {
            // Add token to queue
            this.audioQueue.push(token);

            // Process queue if not already playing
            if (!this.isPlayingAudio) {
                await this.processAudioQueue();
            }
        } catch (error) {
            console.error('TTS error:', error);
        }
    }

    async processAudioQueue() {
        if (this.audioQueue.length === 0) {
            this.isPlayingAudio = false;
            return;
        }

        this.isPlayingAudio = true;

        // Get batch of tokens to speak (for efficiency)
        const batch = this.audioQueue.splice(0, Math.min(5, this.audioQueue.length));
        const textToSpeak = batch.join('');

        try {
            const response = await fetch('http://localhost:3000/tts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: textToSpeak })
            });

            if (!response.ok) throw new Error('TTS failed');

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                this.processAudioQueue(); // Process next batch
            };

            audio.onerror = () => {
                URL.revokeObjectURL(audioUrl);
                this.processAudioQueue(); // Continue even on error
            };

            await audio.play();

        } catch (error) {
            console.error('TTS playback error:', error);
            this.isPlayingAudio = false;
            this.processAudioQueue(); // Continue processing
        }
    }

    visualize() {
        if (!this.analyser) return;

        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        const bars = this.waveform.querySelectorAll('.bar');

        const animate = () => {
            if (!this.isRecording) {
                bars.forEach(bar => bar.style.height = '10px');
                return;
            }

            this.analyser.getByteFrequencyData(dataArray);

            bars.forEach((bar, i) => {
                const value = dataArray[i * 2] || 0;
                const height = Math.max(10, (value / 255) * 60);
                bar.style.height = height + 'px';
            });

            requestAnimationFrame(animate);
        };

        animate();
    }

    stopRecording() {
        this.isRecording = false;
        this.recordBtn.classList.remove('recording');
        this.recordBtn.textContent = '🎤';
        this.stopBtn.style.display = 'none';

        if (this.mediaRecorder) {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            this.mediaRecorder = null;
        }

        if (this.sonioxWs) {
            this.sonioxWs.close();
            this.sonioxWs = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.showStatus('Stopped', false);
    }

    stopAll() {
        this.stopRecording();
        this.audioQueue = [];
        this.isPlayingAudio = false;
    }

    clearAll() {
        this.stopAll();
        this.currentThaiText = '';
        this.currentTranslation = '';
        this.thaiText.textContent = 'Press the button and speak in Thai...';
        this.translatedText.textContent = 'Translation will appear here...';
        this.showStatus('Ready', false);
        this.clearError();
    }

    showStatus(message, active) {
        this.status.textContent = message;
        if (active) {
            this.status.classList.add('active');
        } else {
            this.status.classList.remove('active');
        }
    }

    showError(message) {
        this.errorDiv.textContent = message;
        this.errorDiv.style.display = 'block';
    }

    clearError() {
        this.errorDiv.style.display = 'none';
    }
}

// Initialize the app
const app = new VoiceTranslator();
