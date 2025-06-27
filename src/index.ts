import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import axios from "axios";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import FormData from "form-data";

const execAsync = promisify(exec);

// Configurações
const LANGFLOW_API_URL =
  process.env.LANGFLOW_API_URL;
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

if (!LANGFLOW_API_URL || !OPENAI_API_KEY) {
  throw new Error('Sem chave de API')
}

// Diretórios para salvar arquivos temporários
const TEMP_DIR = "./temp";
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

class WhatsAppLangflowBot {
  private client: Client;
  private processingMessages: Set<string> = new Set();
  private recentMessages: Map<string, number> = new Map(); // Cache de mensagens recentes
  private readonly MESSAGE_CACHE_TTL = 5000; // 5 segundos
  private messageTimestamps: Map<string, number> = new Map(); // Timestamps por chat

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: "whatsapp-langflow-bot",
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // QR Code para autenticação
    this.client.on("qr", (qr) => {
      console.log("📱 Escaneie o QR Code abaixo:");
      qrcode.generate(qr, { small: true });
    });

    // Cliente pronto
    this.client.on("ready", () => {
      console.log("✅ WhatsApp Bot conectado com sucesso!");
    });

    // Receber mensagens
    this.client.on("message", async (message) => {
      await this.handleMessage(message);
    });

    // Erro de autenticação
    this.client.on("auth_failure", (msg) => {
      console.error("❌ Falha na autenticação:", msg);
    });

    // Desconectado
    this.client.on("disconnected", (reason) => {
      console.log("📴 Cliente desconectado:", reason);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      const messageId = message.id.id;
      const currentTime = Date.now();
      const chatId = message.from;

      // Limpar mensagens antigas do cache
      this.cleanupCache();

      // Verificar se a mensagem já foi processada recentemente
      if (this.recentMessages.has(messageId)) {
        console.log(
          `🔄 Mensagem ${messageId} já processada recentemente, ignorando...`
        );
        return;
      }

      // Verificar se é uma mensagem do próprio bot
      if (message.fromMe) {
        console.log(`🤖 Mensagem do próprio bot, ignorando...`);
        return;
      }

      // Verificar se é uma mensagem de sistema ou status
      if (message.type === "protocol" || message.type === "revoked") {
        console.log(`🔧 Mensagem de sistema/status (${message.type}), ignorando...`);
        return;
      }

      // Verificar se já está sendo processada
      if (this.processingMessages.has(messageId)) {
        console.log(
          `⏳ Mensagem ${messageId} já está sendo processada, ignorando...`
        );
        return;
      }

      // Verificar se há mensagens muito recentes do mesmo chat (proteção contra spam)
      const lastMessageTime = this.messageTimestamps.get(chatId);
      if (lastMessageTime && currentTime - lastMessageTime < 1000) {
        console.log(
          `⚡ Mensagem muito recente do chat ${chatId}, ignorando...`
        );
        return;
      }

      // Verificar se a mensagem tem conteúdo válido (exceto para áudio)
      const isAudioMessage = message.type === "ptt" || message.type === "audio";
      if (!isAudioMessage && (!message.body || message.body.trim().length === 0)) {
        console.log(`📝 Mensagem vazia, ignorando...`);
        return;
      }

      // Adicionar ao cache de mensagens recentes
      this.recentMessages.set(messageId, currentTime);
      this.messageTimestamps.set(chatId, currentTime);
      this.processingMessages.add(messageId);

      console.log(`📨 Processando mensagem: ${messageId} de ${message.from}`);

      // Mostrar que está digitando
      const chat = await message.getChat();
      await chat.sendStateTyping();

      let processedContent = "";
      let messageType = "text";

      // Processar diferentes tipos de mensagem
      if (message.hasMedia) {
        console.log(`📁 Mensagem com mídia detectada. Tipo: ${message.type}`);
        const media = await message.downloadMedia();
        console.log(`📥 Mídia baixada. MimeType: ${media.mimetype}`);

        if (message.type === "image") {
          processedContent = await this.processImage(media, message.body);
          messageType = "image";
        } else if (message.type === "ptt" || message.type === "audio") {
          console.log(`🎵 Processando mensagem de áudio...`);
          processedContent = await this.processAudio(media);
          messageType = "audio";
          console.log(`✅ Áudio processado. Conteúdo: ${processedContent}`);
        } else {
          processedContent = message.body || "Arquivo recebido (não suportado)";
        }
      } else {
        processedContent = message.body;
      }

      // Enviar para Langflow
      const aiResponse = await this.callLangflow(
        processedContent,
        messageType,
        message.from
      );

      // Verificar se deve responder em áudio (quando o usuário enviou áudio)
      const shouldRespondWithAudio = message.type === "ptt" || message.type === "audio";

      if (shouldRespondWithAudio) {
        // Detectar preferência de voz da mensagem original
        const voicePreference = this.detectVoicePreference(message.body || "");

        // Tentar gerar e enviar áudio
        const audioMedia = await this.generateAudioFromText(aiResponse, voicePreference);
        if (audioMedia) {
          await message.reply(audioMedia);
          console.log("🎵 Resposta em áudio enviada com sucesso!");
        } else {
          // Fallback para texto se não conseguir gerar áudio
          await message.reply(aiResponse);
          console.log("📝 Fallback para resposta em texto");
        }
      } else {
        // Resposta normal em texto
        await message.reply(aiResponse);
      }
    } catch (error) {
      console.error("❌ Erro ao processar mensagem:", error);
      await message.reply(
        "Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente."
      );
    } finally {
      this.processingMessages.delete(message.id.id);
    }
  }

  private async processImage(
    media: MessageMedia,
    caption?: string
  ): Promise<string> {
    try {
      console.log("🖼️ Processando imagem...");

      // Salvar imagem temporariamente
      const fileName = `image_${Date.now()}.${media.mimetype.split("/")[1]}`;
      const filePath = path.join(TEMP_DIR, fileName);

      const buffer = Buffer.from(media.data, "base64");
      fs.writeFileSync(filePath, buffer);

      // Usar OpenAI Vision API para descrever a imagem
      const imageDescription = await this.analyzeImageWithOpenAI(
        media.data,
        media.mimetype
      );

      // Limpar arquivo temporário
      fs.unlinkSync(filePath);

      const fullContent = caption
        ? `Imagem recebida com legenda: "${caption}". Descrição da imagem: ${imageDescription}`
        : `Imagem recebida. Descrição: ${imageDescription}`;

      return fullContent;
    } catch (error) {
      console.error("❌ Erro ao processar imagem:", error);
      return "Imagem recebida, mas não foi possível analisá-la.";
    }
  }

  private async analyzeImageWithOpenAI(
    imageData: string,
    mimeType: string
  ): Promise<string> {
    try {
      if (!OPENAI_API_KEY) {
        return "Imagem recebida (análise não disponível - configure OPENAI_API_KEY)";
      }
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Descreva esta imagem de forma detalhada para o usuário, ajude-o a entender o que está acontecendo.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${imageData}`,
                  },
                },
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error("❌ Erro na análise da imagem:", error);
      return "Imagem recebida, mas não foi possível analisá-la com IA.";
    }
  }

  private async processAudio(media: MessageMedia): Promise<string> {
    try {
      console.log("🎵 Processando áudio...");
      console.log(`📊 Tamanho da mídia: ${media.data.length} bytes`);
      console.log(`🎵 MimeType: ${media.mimetype}`);

      // Salvar áudio temporariamente
      const fileName = `audio_${Date.now()}.ogg`;
      const filePath = path.join(TEMP_DIR, fileName);
      const wavPath = path.join(TEMP_DIR, `audio_${Date.now()}.wav`);

      console.log(`💾 Salvando áudio em: ${filePath}`);

      const buffer = Buffer.from(media.data, "base64");
      fs.writeFileSync(filePath, buffer);
      console.log(`✅ Áudio salvo com sucesso`);

      // Converter para WAV usando ffmpeg (necessário ter instalado)
      console.log(`🔄 Convertendo para WAV...`);
      await execAsync(`ffmpeg -i "${filePath}" -ar 16000 -ac 1 "${wavPath}"`);
      console.log(`✅ Conversão para WAV concluída`);

      // Transcrever áudio usando OpenAI Whisper
      console.log(`🎤 Iniciando transcrição...`);
      const transcription = await this.transcribeAudioWithOpenAI(wavPath);
      console.log(`✅ Transcrição concluída: "${transcription}"`);

      // Limpar arquivos temporários
      fs.unlinkSync(filePath);
      fs.unlinkSync(wavPath);
      console.log(`🧹 Arquivos temporários removidos`);

      return `Áudio transcrito: "${transcription}"`;
    } catch (error) {
      console.error("❌ Erro ao processar áudio:", error);

      // Tentar limpar arquivos mesmo em caso de erro
      try {
        const fileName = `audio_${Date.now()}.ogg`;
        const filePath = path.join(TEMP_DIR, fileName);
        const wavPath = path.join(TEMP_DIR, `audio_${Date.now()}.wav`);

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      } catch (cleanupError) {
        console.error("❌ Erro ao limpar arquivos temporários:", cleanupError);
      }

      return "Áudio recebido, mas não foi possível transcrevê-lo.";
    }
  }

  private async transcribeAudioWithOpenAI(
    audioFilePath: string
  ): Promise<string> {
    try {
      console.log(`🎤 Iniciando transcrição do arquivo: ${audioFilePath}`);

      if (!OPENAI_API_KEY) {
        console.log("❌ OPENAI_API_KEY não configurada");
        return "Áudio recebido (transcrição não disponível - configure OPENAI_API_KEY)";
      }

      // Verificar se o arquivo existe
      if (!fs.existsSync(audioFilePath)) {
        console.error(`❌ Arquivo de áudio não encontrado: ${audioFilePath}`);
        return "Erro: arquivo de áudio não encontrado";
      }

      console.log(`📁 Arquivo de áudio encontrado. Tamanho: ${fs.statSync(audioFilePath).size} bytes`);

      const formData = new FormData();
      formData.append("file", fs.createReadStream(audioFilePath));
      formData.append("model", "whisper-1");
      formData.append("language", "pt");

      console.log(`🌐 Enviando para OpenAI Whisper...`);

      const response = await axios.post(
        "https://api.openai.com/v1/audio/transcriptions",
        formData,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            ...formData.getHeaders(),
          },
          timeout: 30000, // 30 segundos timeout
        }
      );

      console.log(`✅ Resposta da OpenAI recebida`);
      const transcription = response.data.text || "Não foi possível transcrever o áudio.";
      console.log(`📝 Transcrição: "${transcription}"`);

      return transcription;
    } catch (error) {
      console.error("❌ Erro na transcrição:", error);

      if (axios.isAxiosError(error)) {
        console.error(`📊 Status: ${error.response?.status}`);
        console.error(`📊 Data: ${JSON.stringify(error.response?.data)}`);
      }

      return "Erro ao transcrever áudio.";
    }
  }

  private async generateAudioFromText(text: string, voice: string = "alloy"): Promise<MessageMedia | null> {
    try {
      console.log(`🎤 Gerando áudio com voz: ${voice}...`);
      console.log(`📝 Texto para síntese: "${text}"`);

      if (!OPENAI_API_KEY) {
        console.log("❌ OPENAI_API_KEY não configurada para síntese de voz");
        return null;
      }

      // Validar voz
      const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
      const selectedVoice = validVoices.includes(voice) ? voice : "alloy";
      console.log(`🎵 Voz selecionada: ${selectedVoice}`);

      // Gerar áudio usando OpenAI TTS
      console.log(`🌐 Enviando para OpenAI TTS...`);
      const response = await axios.post(
        "https://api.openai.com/v1/audio/speech",
        {
          model: "tts-1",
          input: text,
          voice: selectedVoice,
          response_format: "mp3",
          speed: 1.0
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          responseType: "arraybuffer",
          timeout: 30000, // 30 segundos timeout
        }
      );

      console.log(`✅ Áudio recebido da OpenAI. Tamanho: ${response.data.length} bytes`);

      // Converter para base64
      const audioBuffer = Buffer.from(response.data);
      const base64Audio = audioBuffer.toString("base64");
      console.log(`🔄 Áudio convertido para base64`);

      // Criar MessageMedia
      const audioMedia = new MessageMedia(
        "audio/mp3",
        base64Audio,
        `audio_response_${Date.now()}.mp3`
      );

      console.log(`✅ MessageMedia criado com sucesso usando voz: ${selectedVoice}!`);
      return audioMedia;
    } catch (error) {
      console.error("❌ Erro ao gerar áudio:", error);

      if (axios.isAxiosError(error)) {
        console.error(`📊 Status: ${error.response?.status}`);
        console.error(`📊 Data: ${error.response?.data}`);
      }

      return null;
    }
  }

  private detectVoicePreference(messageBody: string): string {
    // Sempre usar voz padrão para simplicidade
    return "sage";
  }

  private async callLangflow(
    content: string,
    messageType: string,
    userPhone: string
  ): Promise<string> {
    try {
      console.log("🤖 Enviando para Langflow...");

      const payload = {
        input_value: content,
        output_type: "chat",
        input_type: "chat",
        tweaks: {
          // Adicione seus tweaks específicos do Langflow aqui
          message_type: messageType,
          user_phone: userPhone,
        },
      };

      const response = await axios.post(`${LANGFLOW_API_URL}`, payload, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 segundos timeout
      });

      // Adapte esta parte conforme a estrutura de resposta do seu Langflow
      const aiResponse =
        response.data?.outputs?.[0]?.outputs?.[0]?.results?.message?.text ||
        response.data?.message ||
        "Desculpe, não consegui processar sua solicitação.";

      return aiResponse;
    } catch (error) {
      console.error("❌ Erro ao chamar Langflow:", error);

      if (axios.isAxiosError(error)) {
        if (error.code === "ECONNREFUSED") {
          return "Serviço de IA temporariamente indisponível. Tente novamente em alguns instantes.";
        }
        if (error.response?.status === 404) {
          return "Configuração de IA não encontrada. Verifique as configurações.";
        }
      }

      return "Oii, no momento estou meio off mas não parada, ok? 😅 Estou aprendendo uma nova forma de responder você através de áudios, então já já eu apareço de novo pra responder você! 💖";
    }
  }

  private cleanupCache(): void {
    const currentTime = Date.now();

    // Limpar cache de mensagens recentes
    for (const [id, timestamp] of this.recentMessages.entries()) {
      if (currentTime - timestamp > this.MESSAGE_CACHE_TTL) {
        this.recentMessages.delete(id);
      }
    }

    // Limpar cache de timestamps por chat (mais agressivo)
    for (const [chatId, timestamp] of this.messageTimestamps.entries()) {
      if (currentTime - timestamp > 30000) { // 30 segundos para timestamps de chat
        this.messageTimestamps.delete(chatId);
      }
    }
  }

  public async start(): Promise<void> {
    console.log("🚀 Iniciando WhatsApp Bot...");

    // Configurar limpeza periódica do cache
    setInterval(() => {
      this.cleanupCache();
    }, 10000); // Limpar a cada 10 segundos

    await this.client.initialize();
  }

  public async stop(): Promise<void> {
    console.log("🛑 Parando WhatsApp Bot...");
    await this.client.destroy();
  }
}

// Instanciar e iniciar o bot
const bot = new WhatsAppLangflowBot();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Recebido sinal de interrupção...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Recebido sinal de término...");
  await bot.stop();
  process.exit(0);
});

// Iniciar o bot
bot.start().catch((error) => {
  console.error("❌ Erro ao iniciar o bot:", error);
  process.exit(1);
});

export default WhatsAppLangflowBot;
