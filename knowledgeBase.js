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

        // Documentos padrão sobre Quality Hair
        return [
            {
                id: 'clinic_about',
                title: 'Sobre a Quality Hair',
                content: 'A Quality Hair é uma clínica especializada em transplante capilar com foco em tratamento humanizado. Nossa missão é entregar resultados reais e naturais, transformando vidas através de procedimentos de qualidade. Temos uma equipe de especialistas com experiência em todas as técnicas de transplante capilar modernas.'
            },
            {
                id: 'consultation',
                title: 'Consulta Inicial',
                content: 'A consulta inicial custa R$ 700,00 (agora de graça em promoção). Inclui: Avaliação completa, Planejamento cirúrgico exclusivo, Exame de imagem (tricoscopia digital), Diagnóstico preciso do grau de calvície (Norwood), Discussão de opções de tratamento. Duração: aproximadamente 1-2 horas.'
            },
            {
                id: 'surgery_prices',
                title: 'Preços da Cirurgia',
                content: 'Cirurgia de Transplante Capilar: R$ 12.648,00 em até 24x no cartão de crédito com juros 0% ou R$ 10.000,00 à vista (desconto de R$ 2.648,00) para Pix ou dinheiro. O investimento depende da quantidade de enxertos necessários e será definido no planejamento cirúrgico exclusivo.'
            },
            {
                id: 'surgery_included',
                title: 'O que Está Incluído na Cirurgia',
                content: 'Cada cirurgia inclui: Procedimento de transplante capilar com técnica FUE, Anestesia local, Medicações pós-operatório, Acompanhamento completo por 12 meses, Consultas de acompanhamento (1ª semana, 1º mês, 3º mês, 6º mês, 12º mês), Suporte 24/7 para dúvidas pós-operatório.'
            },
            {
                id: 'results_timeline',
                title: 'Cronograma de Resultados',
                content: 'Primeira semana: Inchaço e repouso. Primeiras semanas: Os cabelos implantados caem (normal). 3º mês: Os fios novos começam a crescer. 6º mês: 50-60% dos resultados visíveis. 9º mês: 80-90% dos resultados. 12º mês: Resultado final completo. O acompanhamento de 12 meses garante que você veja o resultado total.'
            },
            {
                id: 'techniques',
                title: 'Técnicas Disponíveis',
                content: 'Nossa clínica trabalha com: FUE (Follicular Unit Extraction) - técnica mais moderna, menos invasiva, sem cicatriz linear. DHI (Direct Hair Implantation) - implantação direta com precisão. Temos especialistas em ambas as técnicas e recomendamos a melhor para cada caso.'
            },
            {
                id: 'candidacy',
                title: 'Quem Pode Fazer Transplante',
                content: 'O transplante capilar é indicado para: Alopecia androgenética (calvície hereditária), Queda de cabelo significativa (Norwood 2 ou mais), Cabelos e área doadora em bom estado, Expectativas realistas. Não indicado para: Alopecia total, Problemas de saúde graves não controlados. Uma consulta define sua candidatura.'
            },
            {
                id: 'post_care',
                title: 'Cuidados Pós-Operatório',
                content: 'Primeiras 2 semanas: Repouso relativo, evitar exercícios intensos, não lavar a região enxertada. Primeiras 4 semanas: Higiene cuidadosa, dormir com cabeça elevada. Mês 1-3: Evitar exposição solar excessiva, forçar cabelo ao pentear. Medicações: Minoxidil e Finasterida prescritos para potencializar resultados. Acompanhamento: Seguir consultas mensais.'
            },
            {
                id: 'side_effects',
                title: 'Efeitos Colaterais e Riscos',
                content: 'Efeitos colaterais comuns e temporários: Inchaço (3-5 dias), Formigamento (1-2 semanas), Coceira (normal, sinal de cicatrização), Coceira na área doadora. Riscos raros: Infecção (prevenida com antibióticos), Sangramentos leves, Irregularidades no crescimento. Todos são minimizados com técnicas modernas e acompanhamento.'
            },
            {
                id: 'guarantee',
                title: 'Garantias e Políticas',
                content: 'Garantia de sobrevivência dos enxertos: Mínimo 90% de taxa de sobrevivência. Se houver falha de enxertos por erro técnico, oferecemos retoque gratuitamente. Satisfação com resultados: Se não estiver satisfeito em 6 meses, oferecemos ajustes. Política de cancelamento: Cancele até 7 dias antes sem custos.'
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
