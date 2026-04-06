[跳到主要内容](https://docs.ocsjs.com/docs/other/api#__docusaurus_skipToContent_fallback)

[![Logo](https://cdn.ocsjs.com/logo.png)\\
**OCS网课助手**](https://docs.ocsjs.com/)

[首页](https://docs.ocsjs.com/) [使用教程](https://docs.ocsjs.com/docs/quickly-start) [联系方式](https://docs.ocsjs.com/docs/about#%E4%BA%A4%E6%B5%81%E6%96%B9%E5%BC%8F) [GitHub](https://github.com/ocsjs)

- [使用教程](https://docs.ocsjs.com/docs/quickly-start)
- [关于OCS](https://docs.ocsjs.com/docs/about)
- [全部教程](https://docs.ocsjs.com/docs/other/api#)

  - [脚本教程](https://docs.ocsjs.com/docs/script)
  - [软件教程](https://docs.ocsjs.com/docs/app)
  - [手机/平板教程](https://docs.ocsjs.com/docs/mobile)
  - [自动答题教程](https://docs.ocsjs.com/docs/work)
  - [更新教程](https://docs.ocsjs.com/docs/update)
  - [软件辅助](https://docs.ocsjs.com/docs/script-helper)
- [更多](https://docs.ocsjs.com/docs/other/api#)

  - [开发文档](https://docs.ocsjs.com/docs/other/api)
  - [疑问解答](https://docs.ocsjs.com/docs/other/FQA)
  - [远程协助](https://docs.ocsjs.com/docs/other/todesk)
- [问题公示](https://docs.ocsjs.com/docs/other/api#)

  - [关于2025年多个刷课问题公示](https://docs.ocsjs.com/docs/issues/2025)

- [主页面](https://docs.ocsjs.com/)
- 更多
- 开发文档

本页总览

# 开发文档

### 说明 [​](https://docs.ocsjs.com/docs/other/api\#%E8%AF%B4%E6%98%8E "说明的直接链接")

> 由于现在盗版脚本猖獗，所以只提供部分 API 以及开发教程，如需二次开发或者加入开发者，请联系作者进行确认并获取使用步骤。

### 项目技术选型 [​](https://docs.ocsjs.com/docs/other/api\#%E9%A1%B9%E7%9B%AE%E6%8A%80%E6%9C%AF%E9%80%89%E5%9E%8B "项目技术选型的直接链接")

- 框架：原生 js + WebComponent
- 脚本：原生 js + WebComponent

### 项目结构 [​](https://docs.ocsjs.com/docs/other/api\#%E9%A1%B9%E7%9B%AE%E7%BB%93%E6%9E%84 "项目结构的直接链接")

```text
+ packages/
    + core      ## 自研脚本框架
    + scripts   ## 脚本核心实现
    + utils     ## 工具库
```

所有网课学习核心功能都在 `packages/scripts/src/projects/` 文件夹下

### AnswererWrapper 题库配置 [​](https://docs.ocsjs.com/docs/other/api\#AnswererWrapper "AnswererWrapper 题库配置的直接链接")

> OCS 提供了强大的 [`题库配置解析器`](https://github.com/enncy/online-course-script/blob/3.0/packages/scripts/src/browser/core/worker/answer.wrapper.handler.ts)，你可以对接大多数的题库进行使用

**类型** : Array< [`AnswererWrapper`](https://docs.ocsjs.com/docs/other/api#answererwrapper) >

**参数** :

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| url | string | 是 | 请求路径，可已解析 [特殊占位符](https://docs.ocsjs.com/docs/other/api#%E7%89%B9%E6%AE%8A%E5%8D%A0%E4%BD%8D%E7%AC%A6) |
| name | string | 是 | 题库名字 |
| homepage | string | 否 | 题库网址 |
| data | Record<string, string> | 否 | 传递的参数, get 请求将会添加到 url 后面， post 请求会生成请求体 ， 可已解析 [特殊占位符](https://docs.ocsjs.com/docs/other/api#%E7%89%B9%E6%AE%8A%E5%8D%A0%E4%BD%8D%E7%AC%A6) ， 或者 [自定义字段解析方法](https://docs.ocsjs.com/docs/other/api#%E8%87%AA%E5%AE%9A%E4%B9%89%E5%AD%97%E6%AE%B5%E8%A7%A3%E6%9E%90%E6%96%B9%E6%B3%95) |
| method | "post" \| "get" | 否 | 默认 `get` , 请求方法 |
| contentType | "json" \| "text" | 否 | 默认 `json` , 定义 handler 中的参数类型 |
| type | "fetch" \| "GM\_xmlhttpRequest" | 否 | 默认 `fetch` , 请求类型, `fetch` 是用浏览器原生 API， `GM_xmlhttpRequest` 使用油猴自带 API , 可进行跨域。 |
| headers | Record<string, string> | 否 | 默认 `{}` |
| handler | string | 是 | 详情请看下面说明 |

`handler` 选项是个字符串 ， 使用 Function(string) 构造方法进行解析生成方法，方法传入的第一个参数是 `请求获取到的文本/数据（使用 contentType 定义的数据）`

- handler 中需要对请求到的数据进行解析，并返回一个数组，二维数组，或者 undefined

- 注意事项：
  - 如果题库需要返回一个多选题的答案，需要将答案用 [`特殊符号`](https://github.com/ocsjs/ocsjs/blob/4.0/packages/core/src/core/worker/utils.ts#L59) 分隔 ，而不是将答案写成数组。
    - 例子： `return (res)=> res.code === 1 ? [res.question,res.answer.join('#')] : undefined` ， 使用 `join` 方法将数组转换成字符串 。
  - `【重要】`需要将题库配置中 homepage 以及 url 所涉及到的域名，在到脚本头部元信息 `@connect` 中新增域名，否则无法请求到数据。
    - 例子： url 是 [https://example.com/search](https://example.com/search) 则需要添加对应的元信息 `@connect example.com`，或者在脚本管理器设置中找到 `@connect 模式：`， 将其设置为宽松模式。 更多详情请查看油猴跨域 API: `https://www.tampermonkey.net/documentation.php#meta:connect`，
  - 如果不想手动配置 @connect 可以安装官方打包的 [【全域名通用版本】](https://docs.ocsjs.com/docs/other/api#%E5%85%A8%E5%9F%9F%E5%90%8D%E9%80%9A%E7%94%A8%E7%89%88%E6%9C%AC) ，但是请求时会出现弹窗，可以让用户可以选择允许全部域名进行请求。

* * *

- 返回一个数组 : `[题目, 答案]`

> 假设接口数据(res)为：

```json
{
  "code": 1,
  "question": "中国梦是什么？",
  "answer": "实现中华民族伟大复兴，本质是国家富强、民族振兴、人民幸福。"
}
```

handler 例子：

```json
{
  "handler": "return (res)=> res.code === 1 ? [res.question,res.answer] : undefined"
}
```

* * *

- 或者二维数组 : `[[题目1, 答案1], [题目2, 答案2]]` , 注意这里的答案 12，并不是多选题的答案，而是每个题目所对应的答案，因为每个题目搜索时，不同题库返回可以有多个相似的题目。多选题返回格式看上面的注意事项。

> 假设接口数据(res)为：

```json
{
  "code": 1,
  "results": [\
    {\
      "question": "中国梦是什么？",\
      "answer": "实现中华民族伟大复兴，本质是国家富强、民族振兴、人民幸福。"\
    }\
  ]
}
```

handler 例子：

```json
{
  "handler": "return (res)=> res.code === 1 ? res.results.map(r=>([r.question,r.answer])) : undefined"
}
```

* * *

- 如果题库接口搜索不到，需要显示某些信息（需要提醒用户的信息）

> 假设接口数据(res)为：

```json
{
  "code": 0,
  "msg": "搜索不到"
}
```

handler 例子：

```json
{
  "handler": "return (res)=>res.code === 1 ? [res.question,res.answer] : [res.msg, undefined]  "
}
```

* * *

- 如果题库接口不存在题目的内容，题目可以直接写 undefined ，（OCS 会自动将搜索的题目显示）

> 假设接口数据(res)为：

```json
{
  "code": 1,
  "answer": "实现中华民族伟大复兴，本质是国家富强、民族振兴、人民幸福。"
}
```

handler 例子：

```json
{
  "handler": "return (res)=> res.code === 1 ? [undefined, res.answer] : undefined"
}
```

**简单例子**

> 假设有一个接口 : [https://example.com/search?title=1+2,2+3](https://example.com/search?title=1+2,2+3)

> 此接口返回 `{code: 1, data: { answers: [3 , 5] , title:'1+2' }, msg:'成功'}`

```ts
// 这段代码是模仿脚本中的调用方式
defaultAnswerWrapperHandler(
    {
        // 题目
        title: '1+2,2+3',
        // 题目选项
        type: 'single',
        // 题目选项
        options: 'A. xxx\nB. xxx\nC. xxx\nD. xxx'
    },
      // 可以有多个题库配置
    [\
        {\
            url: "https://example.com/search/"// url 也可以进行解析 ${title} , 例如 https://example.com/search/${title}/,\
            method: "get",\
            contentType: "json",\
            data: {\
                title: "${title}", // 1+2,2+3,\
                abc: "123", // 自定义参数,\
            },\
            handler: "return (res)=> res.code === 0 ? undefined : [res.data.title, res.data.answers[0]]"  // 取第一个结果\
            // 或者多个结果\
            // handler: "return (res)=> res.code === 0 ? undefined : res.data.answers.map(a=>([res.data.title, a]))"\
        },\
    ]
);
```

### 自定义字段解析方法 [​](https://docs.ocsjs.com/docs/other/api\#custom-field-handler "自定义字段解析方法的直接链接")

> 4.7.21 版本新增

data 中的数据可以进行自定义解析，原理与 handler 一致，第一个参数是脚本的上下文参数 env: `{title, options, type}`

注意，OCS 只会检测第一层嵌套的字段，如果是对象，并且有 handler 字段，则会进行 `字段解析` ，
如果是字符串，则会进行 [特殊占位符](https://docs.ocsjs.com/docs/other/api#%E7%89%B9%E6%AE%8A%E5%8D%A0%E4%BD%8D%E7%AC%A6) 解析，如果是其他类型，则是按照数据传输。

例子：

```ts
// 这段代码是模仿脚本中的调用方式
defaultAnswerWrapperHandler(
  {
    // 题目
    title: "【单选题】1+2 = ?",
    // 题目选项 目前支持的题目类型有 single,multiple,judgement,completion
    type: "single",
    // 题目选项
    options: "A. 1\nB. 2\nC. 3\nD. 4",
  },
  [\
    // 从这里开始这是题库配置\
    {\
      // ...\
      data: {\
        // 格式必须按照这样写，需要有 handler 字段\
        //例子1： 把 title 进行特殊处理\
        question: {\
          handler: "return (env)=> env.title.replace('单选题','')",\
        },\
        // 如果不想转换，可以正常写\
        question: "${title}",\
        // 例子2 ： 把 options 字段解析成数组，（因为脚本默认传递的 options 参数是一个字符串，每个选项使用 \n 分隔）\
        options: {\
          handler: "return (env)=> env.options.split('\\n')",\
        },\
        // 例子3： 把 type 转换成服务器需要的格式\
        type: {\
          handler: `\
              return (env)=>{\
                return env.type === 'single' ? 1 :\
                env.type === 'multiple' ? 2 :\
                env.type === 'judgement' ? 3 :\
                env.type === 'completion' ? 4 : 0\
              }\
          `,\
        },\
      },\
      // ...\
    },\
  ]
);
```

解析后的实际发送数据为：

```json
{
  "title": "【】1+2 = ?",
  "options": ["A. 1", "B. 2", "C. 3", "D. 4"],
  "type": 1
}
```

多层嵌套数据例子：

> 例子 1\. 魔改 OCS 成 chatgpt 聊天工具

> 使用 chatgpt 在脚本在线搜题功能中实现上下文存储对话

> handler 里面可以使用 \\n 进行代码换行，毕竟是传递到 new Function 的第一个参数里面的

messages 部分的 handler:

```js
return (env) => {
  const messages = JSON.parse(localStorage.getItem("chatgpt-messages") || "[]");
  const content = env.title;
  messages.push({ content, role: "user" });
  localStorage.setItem("chatgpt-messages", JSON.stringify(messages));
  return messages;
};
```

handler 部分:

> 假设响应是 json 格式 ， 并且 res.content 是 chatgpt 的回答， 进行储存对话

```js
return (res) => {
  const messages = JSON.parse(localStorage.getItem("chatgpt-messages") || "[]");
  messages.push({ content: res.content, role: "assistant" });
  localStorage.setItem("chatgpt-messages", JSON.stringify(messages));
  const question = messages[messages.length - 2].content;
  const answer = res.content;
  return [question, answer];
};
```

```json
[\
  {\
    // ... 这里写 chatgpt 接口参数\
    "data": {\
      "messages":{\
        "handler":"\n    return (env)=>{\n        const messages = JSON.parse(localStorage.getItem(\"chatgpt-messages\") || \"[]\")\n        const content = env.title\n        messages.push({content, role: \"user\"})\n  localStorage.setItem('chatgpt-messages', JSON.stringify(messages));\n        return messages\n    }\n"\
      }\
    },\
    "handler":"'return (res) => {\n  const messages = JSON.parse(localStorage.getItem(\"chatgpt-messages\") || \"[]}\");\n  messages.push({ content: res.content, role: \"assistant\" });\n localStorage.setItem('chatgpt-messages', JSON.stringify(messages));\n  const question = messages[messages.length - 2].content;\n  const answer = res.content;\n  return [question, answer];\n}'"\
    ...\
  },\
];
```

魔改结束，这只是示例，并不代表实际能够运行。

* * *

### 特殊占位符 [​](https://docs.ocsjs.com/docs/other/api\#%E7%89%B9%E6%AE%8A%E5%8D%A0%E4%BD%8D%E7%AC%A6 "特殊占位符的直接链接")

- `${xxx}`是变量占位符，是根据脚本中调用的 defaultAnswerWrapperHandler 的第一个参数进行替换，如果脚本调用时没传，则不会替换
  - 可以使用在 `data` 和 `url` 字段中
  - 可以解析
    - `${title}`: 题目标题
    - `${type}`: 题目类型，可能为空
    - `${options}`: 题目选项，可能为空

所以最终填写的 `题库配置` 为： （不要使用这个，这个只是例子！！！！）

```json
[\
  {\
    "url": "https://example.com/search/",\
    "method": "get",\
    "contentType": "json",\
    "data": { "title": "${title}" },\
    "handler": "return (res)=> res.code === 0 ? undefined : [res.data.title, res.data.answers[0]]"\
  }\
]
```

## 全域名通用版本 [​](https://docs.ocsjs.com/docs/other/api\#common-version "全域名通用版本的直接链接")

> 开发人员专用版本，@connect 中自带 \* 全域名通配符，可以跨域请求，但是会弹出提示框，让用户选择是否允许跨域请求。

> 与官方的脚本新版本自动检测同步

- 油叉安装： [https://greasyfork.org/zh-CN/scripts/481438](https://greasyfork.org/zh-CN/scripts/481438)
- 脚本猫脚本站安装： [https://scriptcat.org/zh-CN/script-show-page/1398](https://scriptcat.org/zh-CN/script-show-page/1398)

**标签：**

- [开发文档](https://docs.ocsjs.com/docs/tags/%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3)
- [API](https://docs.ocsjs.com/docs/tags/api)

[编辑此页](https://github.com/enncy/ocs-docs/tree/main/docs/other/api.md)

[上一页\\
\\
软件辅助](https://docs.ocsjs.com/docs/script-helper) [下一页\\
\\
疑问解答](https://docs.ocsjs.com/docs/other/FQA)

- [说明](https://docs.ocsjs.com/docs/other/api#%E8%AF%B4%E6%98%8E)
- [项目技术选型](https://docs.ocsjs.com/docs/other/api#%E9%A1%B9%E7%9B%AE%E6%8A%80%E6%9C%AF%E9%80%89%E5%9E%8B)
- [项目结构](https://docs.ocsjs.com/docs/other/api#%E9%A1%B9%E7%9B%AE%E7%BB%93%E6%9E%84)
- [AnswererWrapper 题库配置](https://docs.ocsjs.com/docs/other/api#AnswererWrapper)
- [自定义字段解析方法](https://docs.ocsjs.com/docs/other/api#custom-field-handler)
- [特殊占位符](https://docs.ocsjs.com/docs/other/api#%E7%89%B9%E6%AE%8A%E5%8D%A0%E4%BD%8D%E7%AC%A6)
- [全域名通用版本](https://docs.ocsjs.com/docs/other/api#common-version)

全部教程

- [使用教程](https://docs.ocsjs.com/docs/quickly-start)
- [脚本教程](https://docs.ocsjs.com/docs/script)
- [软件教程](https://docs.ocsjs.com/docs/app)
- [自动答题教程](https://docs.ocsjs.com/docs/work)

社区/资源

- [油猴中文网](https://bbs.tampermonkey.net.cn/)
- [Tampermonkey(篡改猴)官网](https://tampermonkey.net/)
- [脚本猫](https://scriptcat.org/)

更多

- [疑问解答](https://docs.ocsjs.com/docs/other/FQA)
- [开发文档](https://docs.ocsjs.com/docs/other/api)
- [项目源码](https://github.com/ocsjs)

Copyright © 2020 - 2026 OCS, Built with Docusaurus.