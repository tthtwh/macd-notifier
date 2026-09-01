import { sendServerChan } from '../src/notifier.js';

try {
  await sendServerChan({
    sendKey: process.env.SERVERCHAN_SENDKEY,
    title: '512760 Server酱通知测试',
    description: `这是一条手动测试消息。\n\n发送时间：${new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false
    })}`
  });
  console.info('Server酱测试消息发送成功');
} catch (error) {
  console.error(`Server酱测试消息发送失败：${error.message}`);
  process.exitCode = 1;
}
