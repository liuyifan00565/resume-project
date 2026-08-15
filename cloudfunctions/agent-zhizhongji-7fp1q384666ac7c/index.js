const OpenAI = require("openai");
const tcb = require("@cloudbase/node-sdk");

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });

exports.main = async (event) => {

  const input = event.input || "";
  const fileID = event.fileID || "";
  console.log("收到的fileID:", fileID);

  // 第一层：规则拦截
  if (input.includes("历史")) {
    return {
      type: "task",
      goal: "打开历史记录页面",
      steps: [{ action: "navigate", target: "/pages/history/index" }]
    };
  }

  if (input.includes("报告")) {
    return {
      type: "task",
      goal: "打开作业报告页面",
      steps: [{ action: "navigate", target: "/pages/describe_report/index" }]
    };
  }

  if (input.includes("标签")) {
    return {
      type: "task",
      goal: "打开生成标签页面",
      steps: [{ action: "navigate", target: "/pages/describe_tag/index" }]
    };
  }

  if (input.includes("计数")) {
    return {
      type: "task",
      goal: "打开计数页面",
      steps: [{ action: "navigate", target: "/pages/index/index" }]
    };
  }

  if (input.includes("计算")) {
    return {
      type: "task",
      goal: "打开计算器页面",
      steps: [{ action: "navigate", target: "/pages/calculator/index" }]
    };
  }
  
  const client = new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  });

  // 第二层：有图片时用视觉模型（base64方案，不依赖临时链接）
  if (fileID) {
    try {
      // 直接下载文件内容转base64，避免临时链接跨云访问权限问题
      const downloadResult = await app.downloadFile({ fileID });
      console.log("下载结果keys:", Object.keys(downloadResult));

      const buffer = downloadResult.fileContent;
      if (!buffer) throw new Error("下载文件内容为空");

      const base64 = buffer.toString("base64");
      console.log("base64长度:", base64.length);
      if (base64.length < 100) throw new Error("base64内容异常，可能文件损坏");

      // 根据fileID后缀判断图片格式
      const mimeType = fileID.endsWith(".png") ? "image/png"
                     : fileID.endsWith(".webp") ? "image/webp"
                     : "image/jpeg";

      const response = await client.chat.completions.create({
        model: "qwen-vl-plus",
        messages: [
          {
            role: "system",
            content: "你是智种计农业AI助手，专注种子分析、计数、质检领域。请用中文回答。"
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`
                }
              },
              {
                type: "text",
                text: input || "请分析这张种子图片，识别种类、评估外观质量，给出专业建议"
              }
            ]
          }
        ]
      });

      const content = response.choices[0].message.content;
      const text = Array.isArray(content)
        ? content.map(i => i.text || "").join("\n")
        : content;

      return { type: "text", text };

    } catch (err) {
      console.error("图片处理错误:", err);
      return {
        type: "text",
        text: "图片分析失败：" + (err.message || "未知错误")
      };
    }
  }

  // 第三层：纯文本对话
  const response = await client.chat.completions.create({
    model: "qwen-vl-plus",
    messages: [
      {
        role: "system",
        content: `你是智种计农业AI助手，专注种子分析、计数、质检领域。
        必须返回JSON格式：
        {
          "type": "text",
          "content": "回答内容"
        }
        禁止JSON以外的任何文字。`
      },
      { role: "user", content: input }
    ],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  return {
    type: parsed.type,
    text: parsed.content
  };
};