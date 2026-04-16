/**
 * Knowledge Base & RAG System
 * Armazena documentos sobre a Quality Hair e recupera informações relevantes
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const KB_FILE = path.join(__dirname, 'knowledge_base.json');

class KnowledgeBase {
    constructor() {
        this.documents = this.loadDocuments();
        this.embeddingsCache = {};
        this.documentEmbeddings = {}; // Cache persistente por ID de documento
        this._initialized = false;
    }

    /**
     * Pré-calcula embeddings de todos os documentos da KB no startup
     * Deve ser chamado uma vez após inicializar
     */
    async initialize() {
        if (this._initialized) return;
        
        console.log(`🔄 Pré-calculando embeddings dos ${this.documents.length} documentos da KB...`);
        
        for (const doc of this.documents) {
            try {
                if (!this.documentEmbeddings[doc.id]) {
                    this.documentEmbeddings[doc.id] = await this.getEmbedding(doc.content, doc.id);
                    console.log(`   ✅ Embedding gerado: ${doc.title}`);
                }
            } catch (error) {
                console.error(`   ❌ Falha no embedding de ${doc.title}: ${error.message}`);
            }
        }
        
        this._initialized = true;
        console.log(`✅ KB inicializada com ${Object.keys(this.documentEmbeddings).length} embeddings`);
    }

    /**
     * Carrega documentos da base
     */
    loadDocuments() {
        try {
            if (fs.existsSync(KB_FILE)) {
                const data = fs.readFileSync(KB_FILE, 'utf-8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.warn(`⚠️ Erro ao carregar KB: ${error.message}`);
        }

        // Documentos padrão sobre Quality Hair — Terapia Capilar & Mesoterapia
        // NOTA: Objeções detalhadas foram movidas do system prompt para cá
        return [
            {
                id: 'mesotherapy_what',
                title: 'O que é Mesoterapia Capilar',
                content: 'Microinjeções de vitaminas, biotina, minoxidil, aminoácidos e fatores de crescimento direto na derme do couro cabeludo (2-4mm). Ativos vão direto na raiz, resultado superior a loções tópicas. Técnica consagrada desde 1952. Não-cirúrgico.'
            },
            {
                id: 'mesotherapy_pain',
                title: 'Dor e Conforto',
                content: 'Dor mínima. Agulhas ultrafinas (finas como fio de cabelo). Anestésico tópico disponível se o paciente preferir.'
            },
            {
                id: 'mesotherapy_results',
                title: 'Resultados da Mesoterapia',
                content: 'Redução da queda: a partir da 2ª/3ª sessão. Novos fios: 6-8 semanas após início. Benefícios: nutrição profunda, fios mais grossos, melhor circulação, combate queda genética e por estresse.'
            },
            {
                id: 'mesotherapy_sessions',
                title: 'Sessões e Duração',
                content: 'Cada sessão: 30-60 minutos. Protocolo padrão: 6 sessões (fase intensiva). O ciclo biológico do cabelo exige constância para reativar folículos.'
            },
            {
                id: 'mesotherapy_vs_transplant',
                title: 'Mesoterapia vs Transplante',
                content: 'Mesoterapia reativa folículos "dormindo" e engrossa fios finos sem cirurgia. Muitas vezes recupera volume sem transplante. Funciona como prevenção e restauração.'
            },
            {
                id: 'pricing',
                title: 'Preços',
                content: 'Avaliação Capilar: GRATUITA (15 vagas/semana). Tratamento 6 sessões: R$ 1.899 à vista ou 12x R$ 159,90. Inclui ativos de alta qualidade. SÓ informe preço se o cliente perguntar.'
            },
            {
                id: 'evaluation',
                title: 'Avaliação Gratuita',
                content: 'Presencial na Quality Hair, Vila Mariana, metrô Paraíso, SP. Inclui: análise do couro cabeludo, diagnóstico personalizado, recomendação de protocolo. 15 vagas/semana.'
            },
            {
                id: 'objection_cost',
                title: 'Objeção: Custo alto',
                content: 'Parcelamento 12x R$ 159,90. Tratamento completo com ativos de alta qualidade direto na raiz. Investimento que pode evitar transplante futuro (muito mais caro). Avaliação é gratuita para o cliente entender o valor.'
            },
            {
                id: 'objection_fear',
                title: 'Objeção: Medo de agulha/dor',
                content: 'Agulhas ultrafinas como fio de cabelo. Anestésico tópico garante conforto total. Procedimento tranquilo de 30-60 min.'
            },
            {
                id: 'objection_doubt',
                title: 'Objeção: Desconfiança/funciona?',
                content: 'Técnica consagrada desde 1952. Diferente de loções que a pele mal absorve, os ativos vão direto na raiz. Resultados visíveis a partir da 2ª sessão.'
            },
            {
                id: 'objection_think',
                title: 'Objeção: Vou pensar / Lead frio',
                content: 'Queda capilar é progressiva — folículos podem morrer definitivamente se não tratados. Avaliação é gratuita e sem compromisso. Respeite a decisão do cliente, mas deixe a porta aberta.'
            },
            {
                id: 'objection_research',
                title: 'Objeção: Estou pesquisando',
                content: 'Respeite a pesquisa. Pergunte quais dúvidas restam. Ofereça a avaliação como oportunidade de tirar dúvidas presencialmente, sem compromisso.'
            },
            {
                id: 'location',
                title: 'Localização',
                content: 'Quality Hair — Vila Mariana, próximo ao metrô Paraíso, São Paulo. Fácil acesso por transporte público.'
            }
        ];
    }

    /**
     * Salva documentos (assíncrono)
     */
    async saveDocuments() {
        try {
            await fsPromises.writeFile(KB_FILE, JSON.stringify(this.documents, null, 2));
        } catch (error) {
            console.error(`❌ Erro ao salvar KB: ${error.message}`);
        }
    }

    /**
     * Busca documentos relevantes para uma consulta usando embeddings
     */
    async retrieveRelevantDocuments(query, topK = 3) {
        try {
            // Garantir que embeddings dos docs estão prontos
            if (!this._initialized) await this.initialize();
            
            console.log(`🔍 RAG: Buscando documentos relevantes para: "${query}"`);

            // Gerar embedding apenas da query
            const queryEmbedding = await this.getEmbedding(query);
            if (queryEmbedding.length === 0) return [];

            // Calcular similaridade usando embeddings pré-calculados
            const similarities = [];
            for (const doc of this.documents) {
                const docEmbedding = this.documentEmbeddings[doc.id];
                if (!docEmbedding || docEmbedding.length === 0) continue;
                const similarity = this.cosineSimilarity(queryEmbedding, docEmbedding);
                similarities.push({ doc, similarity });
            }

            // Ordenar por similaridade e pegar top K
            const relevant = similarities
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, topK)
                .filter(item => item.similarity > 0.45); // Threshold: só docs realmente relevantes

            if (relevant.length === 0) {
                console.log(`⚠️ RAG: Nenhum documento altamente relevante encontrado`);
                return [];
            }

            console.log(`✅ RAG: Recuperados ${relevant.length} documentos relevantes`);
            relevant.forEach(item => {
                console.log(`   - ${item.doc.title} (sim: ${item.similarity.toFixed(2)})`);
            });

            return relevant.map(item => item.doc);

        } catch (error) {
            console.error(`❌ Erro no RAG: ${error.message}`);
            return [];
        }
    }

    /**
     * Gera embedding para um texto
     * @param {string} text - Texto para gerar embedding
     * @param {string} cacheId - ID opcional para cache (usa hash do texto se não fornecido)
     */
    async getEmbedding(text, cacheId = null) {
        try {
            // Usar ID explícito ou hash simples do texto completo para evitar colisões
            const cacheKey = cacheId || `query_${this.simpleHash(text)}`;
            if (this.embeddingsCache[cacheKey]) {
                return this.embeddingsCache[cacheKey];
            }

            const response = await openai.embeddings.create({
                input: text,
                model: 'text-embedding-3-small',
            });

            const embedding = response.data[0].embedding;

            // Limitar cache a 200 entradas
            const keys = Object.keys(this.embeddingsCache);
            if (keys.length > 200) delete this.embeddingsCache[keys[0]];

            this.embeddingsCache[cacheKey] = embedding;

            return embedding;
        } catch (error) {
            console.error(`❌ Erro ao gerar embedding: ${error.message}`);
            return [];
        }
    }

    /**
     * Calcula similaridade do cosseno entre dois vetores
     */
    cosineSimilarity(vecA, vecB) {
        const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
        const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
        const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

        if (magnitudeA === 0 || magnitudeB === 0) return 0;
        return dotProduct / (magnitudeA * magnitudeB);
    }

    /**
     * Formata documentos como contexto para Sofia
     */
    formatDocumentsAsContext(documents) {
        if (documents.length === 0) return '';

        // Formato compacto — sem decoração excessiva que incentiva a IA a despejar tudo
        const context = documents
            .map(doc => `• ${doc.title}: ${doc.content}`)
            .join('\n');

        return `[INFO RELEVANTE — use APENAS se o cliente perguntar sobre isso]
${context}`;
    }

    /**
     * Adiciona novo documento
     */
    async addDocument(title, content) {
        const newDoc = {
            id: `doc_${Date.now()}`,
            title,
            content
        };

        this.documents.push(newDoc);
        this.saveDocuments();
        
        // Pré-calcular embedding do novo documento
        try {
            this.documentEmbeddings[newDoc.id] = await this.getEmbedding(content, newDoc.id);
        } catch (error) {
            console.warn(`⚠️ Falha ao gerar embedding para novo doc: ${error.message}`);
        }
        
        console.log(`✅ Documento adicionado: ${title}`);
        return newDoc;
    }

    /**
     * Hash simples para chave de cache (evita colisões por truncamento)
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }
}

module.exports = new KnowledgeBase();
