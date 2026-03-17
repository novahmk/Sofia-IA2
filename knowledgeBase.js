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
        return [
            {
                id: 'clinic_about',
                title: 'Sobre a Quality Hair',
                content: 'A Quality Hair é uma clínica especializada em Terapia Capilar com foco em tratamento humanizado. Localizada na Vila Mariana, próximo ao metrô Paraíso, São Paulo. Nossa missão é entregar resultados reais e naturais, transformando vidas através de procedimentos de qualidade em saúde capilar. Temos uma equipe de especialistas com experiência em Mesoterapia Capilar e tratamentos capilares avançados.'
            },
            {
                id: 'mesotherapy_what',
                title: 'O que é Mesoterapia Capilar',
                content: 'A Mesoterapia Capilar consiste em microinjeções de um "coquetel" de ativos (vitaminas, biotina, minoxidil, aminoácidos, minerais e fatores de crescimento) direto na derme do couro cabeludo, a uma profundidade de 2 a 4mm. Como os ativos vão direto na raiz, o resultado é muito superior a qualquer loção de passar em casa. A técnica é consagrada desde 1952 e é uma das formas mais eficazes de combater a queda capilar sem cirurgia.'
            },
            {
                id: 'mesotherapy_pain',
                title: 'Dor e Conforto na Mesoterapia',
                content: 'A dor da Mesoterapia é mínima. Usamos agulhas ultrafinas, tão finas quanto um fio de cabelo. Se o paciente preferir, aplicamos um anestésico tópico antes para garantir total conforto durante o procedimento. O resultado vale muito a pena.'
            },
            {
                id: 'mesotherapy_results',
                title: 'Resultados da Mesoterapia',
                content: 'A redução da queda capilar geralmente é percebida já na 2ª ou 3ª sessão de Mesoterapia. O crescimento de novos fios costuma aparecer entre 6 a 8 semanas após o início do tratamento. Os benefícios incluem: nutrição profunda do couro cabeludo, aumento da densidade capilar (fios mais grossos), estímulo da circulação sanguínea local e combate à queda genética ou por estresse.'
            },
            {
                id: 'mesotherapy_sessions',
                title: 'Sessões e Duração do Tratamento',
                content: 'Cada sessão de Mesoterapia dura entre 30 a 60 minutos. O protocolo padrão é de 6 sessões na fase intensiva. A quantidade de sessões é pensada para respeitar o ciclo de crescimento do cabelo — é um processo biológico que leva tempo para reativar os folículos e fortalecer os fios. É como regar uma planta: precisa de constância para florescer.'
            },
            {
                id: 'mesotherapy_vs_transplant',
                title: 'Mesoterapia vs Transplante Capilar',
                content: 'Muitas pessoas acham que a única solução para queda capilar é o transplante, mas com a Mesoterapia Capilar conseguimos reativar folículos que estão "dormindo" e engrossar os fios que ficaram finos. Muitas vezes, recuperamos o volume sem precisar de cirurgia. A Mesoterapia é um investimento na saúde contínua do cabelo que nutre folículos, fortalece fios existentes e estimula crescimento de novos, funcionando como cuidado preventivo e restaurador.'
            },
            {
                id: 'pricing',
                title: 'Preços do Tratamento',
                content: 'Avaliação Capilar: GRATUITA (vagas limitadas — apenas 15 por semana). Tratamento completo de 6 sessões de Mesoterapia Capilar personalizada: R$ 1.899,00 à vista ou 12x de R$ 159,90 no cartão. O valor inclui ativos de alta qualidade aplicados diretamente onde o cabelo precisa. O preço não deve ser mencionado logo de cara — o foco inicial é o valor da avaliação gratuita.'
            },
            {
                id: 'evaluation',
                title: 'Avaliação Gratuita',
                content: 'A avaliação gratuita é presencial na clínica Quality Hair, Vila Mariana, próximo ao metrô Paraíso, São Paulo. Inclui análise detalhada do couro cabeludo e dos fios, diagnóstico personalizado e recomendação de protocolo ideal. Temos apenas 15 vagas por semana para avaliação gratuita — gatilho de escassez real. O objetivo é que o paciente venha à clínica para entender o valor real do tratamento para o seu caso.'
            },
            {
                id: 'objections',
                title: 'Tratamento de Objeções Comuns',
                content: 'Objeções comuns incluem: Custo alto (reforçar parcelamento 12x R$ 159,90 e valor do tratamento completo), Medo de agulha (agulhas ultrafinas + anestésico tópico), Desconfiança (técnica consagrada desde 1952, ativos direto na raiz), Quero pensar (queda é progressiva, folículos podem morrer definitivamente), Resultados a longo prazo (investimento preventivo que evita necessidade futura de transplante).'
            },
            {
                id: 'location',
                title: 'Localização e Contato',
                content: 'A clínica Quality Hair fica na Vila Mariana, próximo ao metrô Paraíso, São Paulo. Fácil acesso por transporte público. Atendimento presencial para avaliações e sessões de Mesoterapia Capilar.'
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
                .filter(item => item.similarity > 0.3); // Threshold mínimo

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

        const context = documents
            .map(doc => `📚 ${doc.title}\n${doc.content}`)
            .join('\n\n---\n\n');

        return `
[CONTEXTO DO CONHECIMENTO BASE]
Informações relevantes sobre Quality Hair:

${context}

[FIM DO CONTEXTO]
`;
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
