'use strict';

const cloud = require('wx-server-sdk');
const https = require('https');
function buildSystemMessage() {
  const now = new Date();

  const timeStr = now.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  return {
    role: "system",
    content:
      `当前日期时间是：${timeStr}（中国北京时间）。
请基于当前时间回答问题。
如果涉及日期、年份、节假日、时间判断，请以此时间为准。`
  };
}

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function httpsPostJson({ hostname, path, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);

    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw || '{}');
          } catch (e) {
            // keep raw
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            raw,
            json: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    req.write(data);
    req.end();
  });
}

function normalizeMessages(eventMessages) {
  // 兼容：传进来可能是 [{role,content}, ...] 或者只给 text
  if (Array.isArray(eventMessages) && eventMessages.length > 0) {
    return eventMessages
      .filter((m) => m && typeof m === 'object' && typeof m.content === 'string')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
  }

  const text = typeof eventMessages === 'string' ? eventMessages : '';
  return [{ role: 'user', content: text }];
}

exports.main = async (event, context) => {
  try {
    const apiKey = process.env.QIANFAN_API_KEY; // 形如：bce-v3/xxx
    if (!apiKey) {
      return {
        reply:
          '请先在云函数环境变量里配置 QIANFAN_API_KEY（千帆控制台的 API Key，形如 bce-v3/xxx）。',
      };
    }

    const model = process.env.QIANFAN_MODEL || 'qianfan-sug-8k'; // 建议先用这个
    // const messages = normalizeMessages(event.messages || event.text || '');
    const systemMessage = buildSystemMessage();
    const userMessages = normalizeMessages(event.messages || event.text);
    
    const messages = [
      systemMessage,
      ...userMessages
    ];
    
    // 千帆 OpenAI 兼容接口：base_url = https://qianfan.baidubce.com/v2
    // chat completions：POST /v2/chat/completions
    const payload = {
      model,
      messages,
      temperature: 0.7,
      top_p: 0.95,
      stream: false,
    };

    const resp = await httpsPostJson({
      hostname: 'qianfan.baidubce.com',
      path: '/v2/chat/completions',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      timeoutMs: 15000,
    });

    // 处理非 2xx
    if (!resp.statusCode || resp.statusCode < 200 || resp.statusCode >= 300) {
      // 尽量把千帆返回的错误信息带出来
      const errMsg =
        (resp.json && (resp.json.message || resp.json.error?.message)) ||
        resp.raw ||
        `HTTP ${resp.statusCode}`;

      // 如果是 invalid_model，说明 model 参数不对或你没权限
      return {
        reply:
          `请求失败：HTTP ${resp.statusCode}\n` +
          `错误：${errMsg}\n` +
          `排查：1) QIANFAN_API_KEY 是否是 bce-v3/..；2) model 是否在“模型列表”的 model参数 中，且你账号有权限；3) 控制台是否已开通对应模型。`,
      };
    }

    // OpenAI 风格返回：choices[0].message.content
    const content =
      resp.json?.choices?.[0]?.message?.content ??
      resp.json?.result ??
      resp.json?.output ??
      '';

    return { reply: content || '(未返回内容)' };
  } catch (err) {
    console.error('doubaoChat error:', err);
    return {
      reply:
        '请求失败（云函数异常）：\n' +
        (err?.message || 'unknown') +
        '\n请检查：1) 云函数环境变量 QIANFAN_API_KEY；2) 网络是否可访问 qianfan.baidubce.com；3) model 是否可用。',
    };
  }
};
