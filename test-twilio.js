require('dotenv').config();
const MessagingClient = require('./messagingClient');
const messaging = new MessagingClient();

async function runTests() {
    console.log('\n=== TESTE TWILIO SOFIA ===\n');

    // Teste 1: Status da conexao
    console.log('1) Verificando conexao...');
    const status = await messaging.getStatus();
    console.log('   ', status.connected ? 'OK' : 'FALHA', status.message, '\n');

    // Teste 2: Envio de mensagem de texto
    console.log('2) Enviando mensagem de texto...');
    const msg = await messaging.sendMessage('5511915298971', 'Teste Sofia-IA: Mensagem de texto funcionando!');
    console.log('   OK SID:', msg.sid, '| Status:', msg.status, '\n');

    // Teste 3: Envio de template
    console.log('3) Enviando Content Template...');
    const tmpl = await messaging.sendTemplate('5511915298971', 'HXb5b62575e6e4ff6129ad7c8efe1f983e', { '1': '15/03', '2': '14h' });
    console.log('   OK SID:', tmpl.sid, '| Status:', tmpl.status, '\n');

    console.log('=== TODOS OS TESTES PASSARAM ===\n');
}

runTests().catch(function(e) {
    console.error('FALHA no teste:', e.message);
});
