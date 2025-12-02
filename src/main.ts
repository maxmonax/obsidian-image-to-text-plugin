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

			const payload = {
				model: this.settings.model || "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text:
									"Извлеки весь текст с этого изображения, если это визитка, то верни данные строго в таком JSON формате:\n\n" +
									"{\n" +
									'  "name": "",\n' +
									'  "company": "",\n' +
									'  "position": "",\n' +
									'  "phones": [],\n' +
									'  "emails": [],\n' +
									'  "website": "",\n' +
									'  "address": "",\n' +
									'  "rawText": ""\n' +
									"}\n\n" +
									"Заполни максимально точно по содержимому визитки."
							},
							{
								type: "image_url",
								image_url: {
									url: `data:image/jpeg;base64,${base64}`
								}
							}
						]
					}
				]
			};

			const response = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${this.settings.openaiApiKey}`
				},
				body: JSON.stringify(payload)
			});

			if (!response.ok) {
				const errText = await response.text();
				console.error("OpenAI API Error:", response.status, errText);
				new Notice(`❌ OpenAI API error ${response.status}: ${errText.slice(0, 120)}...`);
				return;
			}

			const data = await response.json();
			const content = data?.choices?.[0]?.message?.content ?? "{}";

			let parsed;
			try {
				parsed = JSON.parse(content);
			} catch (e) {
				console.error("JSON parse error:", content);
				new Notice("❌ Failed to parse contact JSON");
				return;
			}

			const name = parsed.name?.trim() || "Unknown Contact";

			// Сохраняем заметку рядом с файлом
			const notePath = `${file.parent?.path ?? ""}/${name}.md`;

			// Вставляем изображение как вложение Obsidian
			const imageEmbed = `![[${file.name}]]`;

			// Создаём текст заметки
			const noteContent = `# ${name}

				${imageEmbed}

				**Компания:**  
				${parsed.company || "-"}

				**Должность:**  
				${parsed.position || "-"}

				**Телефоны:**  
				${parsed.phones?.length ? parsed.phones.map((p: string) => `- ${p}`).join("\n") : "-"}

				**Email:**  
				${parsed.emails?.length ? parsed.emails.map((e: string) => `- ${e}`).join("\n") : "-"}

				**Website:**  
				${parsed.website || "-"}

				**Адрес:**  
				${parsed.address || "-"}

				---

				## Полный текст визитки
				${parsed.rawText || ""}
			`;

			await this.app.vault.create(notePath, noteContent);
			new Notice(`✅ Contact saved: ${name}`);
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