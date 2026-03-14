/**
 * Script de teste para validar conexão com OpenAI
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');

console.log('🔍 === TESTE DE CONEXÃO OPENAI ===\n');

// Verificar variáveis de ambiente
console.log('📋 Verificando variáveis de ambiente:');
console.log(`✓ OPENAI_API_KEY definida: ${process.env.OPENAI_API_KEY ? 'SIM' : 'NÃO'}`);

if (!process.env.OPENAI_API_KEY) {
    console.error('❌ ERRO: OPENAI_API_KEY não está configurada no .env');
    process.exit(1);
}

// Inicializar cliente OpenAI
console.log('\n🔗 Inicializando cliente OpenAI...');
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

console.log('✓ Cliente criado com sucesso\n');

// Testar chamada simples
async function testOpenAI() {
    try {
        console.log('📤 Enviando teste à API OpenAI...');
        const startTime = Date.now();

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "Você é Sofia, uma IA amigável." },
                { role: "user", content: "Olá Sofia, tudo bem?" }
            ],
            temperature: 0.7,
            max_tokens: 100
        });

        const latency = Date.now() - startTime;

        console.log(`\n✅ SUCESSO! Resposta recebida em ${latency}ms\n`);
        console.log('📝 Detalhes da resposta:');
        console.log(`   Model: ${response.model}`);
        console.log(`   Tokens utilizados: ${response.usage.total_tokens}`);
        console.log(`   Mensagem: "${response.choices[0].message.content}"\n`);

        console.log('🎉 A API OpenAI está funcionando corretamente!');

    } catch (error) {
        console.error(`\n❌ ERRO na chamada à API:\n`);
        console.error(`   Tipo: ${error.constructor.name}`);
        console.error(`   Código: ${error.status || error.code || 'DESCONHECIDO'}`);
        console.error(`   Mensagem: ${error.message}\n`);

        if (error.status === 401) {
            console.error('⚠️  Possível causa: Chave API inválida ou expirada');
        } else if (error.status === 429) {
            console.error('⚠️  Possível causa: Limite de taxa excedido');
        } else if (error.message.includes('connection')) {
            console.error('⚠️  Possível causa: Problema de conexão de rede');
        }

        console.error('\n💡 Dicas:');
        console.error('   1. Verifique se a chave API está correta');
        console.error('   2. Visite https://platform.openai.com/account/api-keys');
        console.error('   3. Verifique se sua conta tem créditos');
        console.error('   4. Confirme a conexão de internet\n');

        process.exit(1);
    }
}

testOpenAI();
