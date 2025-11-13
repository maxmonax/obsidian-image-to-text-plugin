import { App, Plugin, PluginSettingTab, Setting, TFile, Notice } from "obsidian";

// =============== SETTINGS ==================

interface ImageToTextSettings {
	openaiApiKey: string;
	model: string;
}

const DEFAULT_SETTINGS: ImageToTextSettings = {
	openaiApiKey: "",
	model: "gpt-4o-mini"
};

// =============== MAIN PLUGIN CLASS ==================

export default class ImageToTextPlugin extends Plugin {
	settings: ImageToTextSettings = DEFAULT_SETTINGS;

	async onload() {
		console.log("✅ ImageToTextPlugin loaded");

		await this.loadSettings();
		this.addSettingTab(new ImageToTextSettingTab(this.app, this));

		// Отслеживаем добавление новых файлов в хранилище
		this.registerEvent(
			this.app.vault.on("create", async (file: TFile) => {
				if (file.extension.match(/(png|jpg|jpeg|webp)/i)) {
					new Notice(`🖼 Processing ${file.name}...`);
					await this.processImage(file);
				}
			})
		);
	}

	onunload() {
		console.log("🛑 ImageToTextPlugin unloaded");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// =============== IMAGE PROCESSING ==================

	async processImage(file: TFile) {
		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			const base64 = arrayBufferToBase64(arrayBuffer);

			if (!this.settings.openaiApiKey) {
				new Notice("⚠️ Please set your OpenAI API key in the plugin settings.");
				return;
			}

			new Notice(`📤 Sending ${file.name} to OpenAI...`);

			const response = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${this.settings.openaiApiKey}`
				},
				body: JSON.stringify({
					model: this.settings.model,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "Извлеки весь текст с этого изображения. Если текста нет — опиши, что изображено."
								},
								{
									type: "image_url",
									image_url: `data:image/png;base64,${base64}`
								}
							]
						}
					]
				})
			});

			if (!response.ok) {
				const errText = await response.text();
				console.error("OpenAI API Error:", response.status, errText);
				new Notice(`❌ OpenAI API error: ${response.status}`);
				return;
			}

			const data = await response.json();
			const text = data?.choices?.[0]?.message?.content ?? "⚠️ No text detected.";

			const notePath = file.path.replace(/\.\w+$/, ".md");
			await this.app.vault.create(notePath, text);

			new Notice(`✅ Text extracted from ${file.name}`);
		} catch (err) {
			console.error("Error processing image:", err);
			new Notice(`❌ Error processing ${file.name}`);
		}
	}
}

// =============== SETTINGS TAB ==================

class ImageToTextSettingTab extends PluginSettingTab {
	plugin: ImageToTextPlugin;

	constructor(app: App, plugin: ImageToTextPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "🧠 Image to Text Plugin Settings" });

		new Setting(containerEl)
			.setName("OpenAI API Key")
			.setDesc("Введи свой OpenAI API ключ (начинается с sk-...)")
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.openaiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Модель с поддержкой изображений (например, gpt-4o-mini или gpt-4o).")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o-mini")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
						await this.plugin.saveSettings();
					})
			);
	}
}

// =============== UTILS ==================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}
	return btoa(binary);
}