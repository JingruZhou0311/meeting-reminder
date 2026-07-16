#!/usr/bin/env node

/**
 * 会议每日工作提醒 - GitHub Actions 版
 * 每天 8:00 (北京时间) 自动计算5场会议的待办任务并推送到企业微信群
 *
 * 周末任务智能分散：
 * - 会议现场相关任务（会前2天~会后1天）→ 周末照常推送，必须到现场
 * - 远期会前准备（3天以上）→ 前移至周四
 * - 远期会后跟进（2天以上）→ 顺延至周一
 * - 周末无会议任务 → 不推送
 * 运行在 GitHub 云服务器上，不依赖本地电脑开关机
 *
 * 规则来源：活动执行细则.xlsx（2026-07-15 更新版）
 */

const https = require('https');

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const WEBHOOK_KEY = '74947e3c-7af3-4499-9a98-4ab66ec5fd54';
const DASHBOARD_URL = 'https://625851d8924044e3a87217e17cbf07f3.app.codebuddy.work';

// 5场会议信息
const meetings = [
  { name: '武汉会议', date: { y: 2026, m: 7, d: 18 }, emoji: '🔴' },
  { name: '河南会议', date: { y: 2026, m: 7, d: 25 }, emoji: '🟠' },
  { name: '南京会议', date: { y: 2026, m: 8, d: 8 }, emoji: '🟡' },
  { name: '济南会议', date: { y: 2026, m: 8, d: 22 }, emoji: '🟢' },
  { name: '武汉会议', date: { y: 2026, m: 8, d: 23 }, emoji: '🔵' },
];

// 执行流程规则
// daysBefore: 正数 = 会前N天, 0 = 会议当天/当天结束后, 负数 = 会后N天
// rangeNote: 范围型任务的标注（在范围的开始日和截止日各显示一次）
const taskRules = [
  // ── 会前60天 ──
  { daysBefore: 60, role: '会议Owner', task: '拟日程框架，建工作群，第一次会议筹备会（全体）' },

  // ── 会前30-45天（范围，在45天和30天各提醒一次）──
  { daysBefore: 45, role: '主席负责同事&会议Owner', task: '确定会议时间、会场酒店、确认主席', rangeNote: '会前30-45天·开始' },
  { daysBefore: 30, role: '主席负责同事&会议Owner', task: '确定会议时间、会场酒店、确认主席', rangeNote: '会前30-45天·截止' },
  { daysBefore: 45, role: '会议Owner', task: '与学会执行方、旅行社开沟通会（执行细则）', rangeNote: '会前30-45天·开始' },
  { daysBefore: 30, role: '会议Owner', task: '与学会执行方、旅行社开沟通会（执行细则）', rangeNote: '会前30-45天·截止' },
  { daysBefore: 45, role: '学会执行方', task: '预定会场（注意启动仪式要求会场开面大）', rangeNote: '会前30-45天·开始' },
  { daysBefore: 30, role: '学会执行方', task: '预定会场（注意启动仪式要求会场开面大）', rangeNote: '会前30-45天·截止' },

  // ── 会前30天 ──
  { daysBefore: 30, role: '对应业务同事&会议Owner', task: '确认会议主持、讲者' },
  { daysBefore: 30, role: '会议Owner', task: '提供讲课PPT' },

  // ── 会前15-30天（范围，在30天和15天各提醒一次）──
  { daysBefore: 30, role: '会议Owner&对应业务同事', task: '预约医学部帮忙专家过幻灯（核心内容传递）', rangeNote: '会前15-30天·开始' },
  { daysBefore: 15, role: '会议Owner&对应业务同事', task: '预约医学部帮忙专家过幻灯（核心内容传递）', rangeNote: '会前15-30天·截止' },

  // ── 会前15天 ──
  { daysBefore: 15, role: '会议Owner&学会执行方', task: '确认所有角色嘉宾，日程设计稿完稿（同步收集所有角色嘉宾简历）' },

  // ── 会前10-15天（范围，在15天和10天各提醒一次）──
  { daysBefore: 15, role: '学会旅行社', task: '收集专家行程', rangeNote: '会前10-15天·开始' },
  { daysBefore: 10, role: '学会旅行社', task: '收集专家行程', rangeNote: '会前10-15天·截止' },

  // ── 会前10天 ──
  { daysBefore: 10, role: '会议Owner', task: '第二次全体沟通会（介绍会议整体安排，行程预定、差旅标准等）' },

  // ── 会前7-10天（范围，在10天和7天各提醒一次）──
  { daysBefore: 10, role: '学会执行方', task: '所有角色嘉宾沟通函、讨论话题等资料准备完毕', rangeNote: '会前7-10天·开始' },
  { daysBefore: 7, role: '学会执行方', task: '所有角色嘉宾沟通函、讨论话题等资料准备完毕', rangeNote: '会前7-10天·截止' },

  // ── 会前7天 ──
  { daysBefore: 7, role: '学会旅行社&对应业务同事', task: '机票/高铁出票' },
  { daysBefore: 7, role: '会议Owner&对应业务同事', task: '主席、主持、讲者会前拜访（介绍会议流程、传递会议关键信息、把控观念）' },
  { daysBefore: 7, role: '学会执行方', task: '串场制作、会议相关所有物料完成设计' },

  // ── 会前3-7天（范围，在7天和3天各提醒一次）──
  { daysBefore: 7, role: '对应业务同事', task: '讨论嘉宾拜访', rangeNote: '会前3-7天·开始' },
  { daysBefore: 3, role: '对应业务同事', task: '讨论嘉宾拜访', rangeNote: '会前3-7天·截止' },

  // ── 会前3-5天（范围，在5天和3天各提醒一次）──
  { daysBefore: 5, role: '会议Owner', task: '第三次全体沟通会（行前沟通会-会议当天细节流程、用餐、住宿、会议分工等安排）', rangeNote: '会前3-5天·开始' },
  { daysBefore: 3, role: '会议Owner', task: '第三次全体沟通会（行前沟通会-会议当天细节流程、用餐、住宿、会议分工等安排）', rangeNote: '会前3-5天·截止' },

  // ── 会前2天 ──
  { daysBefore: 2, role: '对应业务同事', task: '当地参会专家行程提供' },

  // ── 会前1天 ──
  { daysBefore: 1, role: '学会旅行社', task: '当地参会专家车辆安排（提前一天发在工作群）' },
  { daysBefore: 1, role: '会议Owner&学会执行方&旅行社', task: '会议彩排、会议茶歇、咖啡、用餐再次check，是否需要桌餐，内部同事用餐' },

  // ── 会议当天 ──
  { daysBefore: 0, role: '会议Owner&业务同事', task: '会议当天专家接待' },
  { daysBefore: 0, role: '学会执行方&旅行社', task: '签到、劳务协议签署' },

  // ── 会议结束当天 ──
  { daysBefore: 0, role: '学会执行方', task: '劳务相关材料收集要求，收集表格等信息发工作群通知' },

  // ── 会议结束3天内（范围，在会后第1天和第3天各提醒一次）──
  { daysBefore: -1, role: '学会执行方&会议Owner', task: '赞助权益材料，学会实际日程盖章，公司系统关会', rangeNote: '会后3天内·开始' },
  { daysBefore: -3, role: '学会执行方&会议Owner', task: '赞助权益材料，学会实际日程盖章，公司系统关会', rangeNote: '会后3天内·截止' },

  // ── 会议结束后2周内（范围，在会后第1天和第14天各提醒一次）──
  { daysBefore: -1, role: '学会旅行社&所有相关业务同事', task: '业务同事垫付的所有报销材料提交', rangeNote: '会后2周内·开始' },
  { daysBefore: -14, role: '学会旅行社&所有相关业务同事', task: '业务同事垫付的所有报销材料提交', rangeNote: '会后2周内·截止' },

  // ── 会议结束后1个月内（范围，在会后第1天和第30天各提醒一次）──
  { daysBefore: -1, role: '学会执行方&会议Owner', task: '劳务所有材料收集完毕', rangeNote: '会后1个月内·开始' },
  { daysBefore: -30, role: '学会执行方&会议Owner', task: '劳务所有材料收集完毕', rangeNote: '会后1个月内·截止' },

  // ── 会议结束后2个月内（范围，在会后第1天和第60天各提醒一次）──
  { daysBefore: -1, role: '会议Owner&学会执行方', task: '劳务支付', rangeNote: '会后2个月内·开始' },
  { daysBefore: -60, role: '会议Owner&学会执行方', task: '劳务支付', rangeNote: '会后2个月内·截止' },
];

// ═══════════════════════════════════════════
// 日期工具（始终计算北京时间 UTC+8）
// ═══════════════════════════════════════════

function getBeijingToday() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijing = new Date(utcMs + 8 * 3600000);
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    y: beijing.getFullYear(),
    m: beijing.getMonth() + 1,
    d: beijing.getDate(),
    day: beijing.getDay(),
    dayStr: '周' + weekDays[beijing.getDay()],
  };
}

function daysUntil(today, meeting) {
  const t = Date.UTC(today.y, today.m - 1, today.d);
  const m = Date.UTC(meeting.y, meeting.m - 1, meeting.d);
  return Math.round((m - t) / 86400000);
}

// 在某日期基础上加N天，返回新的日期对象
function addDays(dateObj, n) {
  var d = new Date(Date.UTC(dateObj.y, dateObj.m - 1, dateObj.d));
  d.setUTCDate(d.getUTCDate() + n);
  var weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    day: d.getUTCDay(),
    dayStr: '周' + weekDays[d.getUTCDay()],
  };
}

// ═══════════════════════════════════════════
// 周末任务智能分散
// 如果任务的自然日期落在周末：
//   会议现场相关（会前2天~会后1天）→ 不移动，必须到现场执行
//   远期会前准备（3天以上）→ 前移至周四
//   远期会后跟进（2天以上）→ 顺延至周一
// ═══════════════════════════════════════════

function getEffectiveDate(meetingDate, daysBefore) {
  // 计算自然日期（会议日期 - daysBefore 天）
  var naturalDate = addDays(meetingDate, -daysBefore);

  // 工作日（周一~周五）→ 原样返回
  if (naturalDate.day >= 1 && naturalDate.day <= 5) {
    return { date: naturalDate, moved: false, moveNote: '' };
  }

  // 周末，但会议现场相关任务（会前2天~会后1天）→ 不移动，必须到现场执行
  if (daysBefore >= -1 && daysBefore <= 2) {
    return { date: naturalDate, moved: false, moveNote: '' };
  }

  // 周末的远期任务 → 分散到工作日
  var targetDate;
  var moveNote;

  if (daysBefore > 0) {
    // 远期会前准备（3天以上）→ 前移至周四
    var backDays = naturalDate.day === 6 ? 2 : 3; // 周六退2天，周日退3天
    targetDate = addDays(naturalDate, -backDays);
    moveNote = '原定周' + (naturalDate.day === 6 ? '六' : '日') + '·提前至周四';
  } else {
    // 远期会后跟进（2天以上）→ 顺延至周一
    var fwdDays = naturalDate.day === 6 ? 2 : 1; // 周六进2天，周日进1天
    targetDate = addDays(naturalDate, fwdDays);
    moveNote = '原定周' + (naturalDate.day === 6 ? '六' : '日') + '·顺延至周一';
  }

  return { date: targetDate, moved: true, moveNote: moveNote };
}

// ═══════════════════════════════════════════
// 格式化工具
// ═══════════════════════════════════════════

var numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function getNumberLabel(n) {
  if (n <= 10) return numberEmojis[n - 1];
  return n + '. ';
}

function getColor(daysUntilMeeting) {
  if (daysUntilMeeting < 0) return 'comment';   // 已结束 - 灰色
  if (daysUntilMeeting <= 7) return 'warning';   // 7天内 - 橙红
  if (daysUntilMeeting <= 14) return 'info';      // 8-14天 - 绿色
  return 'comment';                              // 14天以上 - 灰色
}

function getUrgency(daysUntilMeeting) {
  if (daysUntilMeeting === 0) return ' ⚠️ 会议当天';
  if (daysUntilMeeting >= 1 && daysUntilMeeting <= 3) return ' ⚠️ 关键期';
  return '';
}

function getStageLabel(daysUntilMeeting) {
  if (daysUntilMeeting > 0) return '会前' + daysUntilMeeting + '天';
  if (daysUntilMeeting === 0) return '会议当天';
  return '会后' + Math.abs(daysUntilMeeting) + '天';
}

// ═══════════════════════════════════════════
// 生成提醒内容
// ═══════════════════════════════════════════

var lastHasTasks = false;

function generateReminder(today) {
  var parts = [];

  // 标题
  parts.push('## 📋 会议每日工作提醒');
  parts.push('> 📅 ' + today.m + '月' + today.d + '日 ' + today.dayStr);
  parts.push('');

  // 遍历所有会议和规则，找出"有效日期"等于今天的任务
  var taskNumber = 0;
  var hasTasks = false;
  var tasksByMeeting = {};

  for (var i = 0; i < meetings.length; i++) {
    var meeting = meetings[i];
    var dim = daysUntil(today, meeting.date);

    // 只处理会后2个月内的会议
    if (dim < -60) continue;

    for (var j = 0; j < taskRules.length; j++) {
      var rule = taskRules[j];
      var eff = getEffectiveDate(meeting.date, rule.daysBefore);

      // 有效日期是否等于今天
      if (eff.date.y === today.y && eff.date.m === today.m && eff.date.d === today.d) {
        if (!tasksByMeeting[i]) {
          tasksByMeeting[i] = { meeting: meeting, dim: dim, tasks: [] };
        }
        tasksByMeeting[i].tasks.push({ rule: rule, moveNote: eff.moveNote });
        hasTasks = true;
      }
    }
  }

  // 按会议分组渲染
  for (var key in tasksByMeeting) {
    var group = tasksByMeeting[key];
    var m = group.meeting;
    var dim = group.dim;

    var color = getColor(dim);
    var urgency = getUrgency(dim);
    var stageLabel = getStageLabel(dim);
    var dateLabel = m.date.m + '/' + m.date.d;

    parts.push('<font color="' + color + '">' + m.emoji + ' ' + m.name + ' · ' + dateLabel + ' · ' + stageLabel + urgency + '</font>');
    parts.push('');

    for (var k = 0; k < group.tasks.length; k++) {
      taskNumber++;
      var t = group.tasks[k];
      var taskText = t.rule.task;
      if (t.rule.rangeNote) {
        taskText += '（' + t.rule.rangeNote + '）';
      }
      if (t.moveNote) {
        taskText += '（' + t.moveNote + '）';
      }
      parts.push(getNumberLabel(taskNumber) + ' 【' + t.rule.role + '】' + taskText);
    }
    parts.push('');
  }

  // 无任务时的提示
  if (!hasTasks) {
    parts.push('今日无紧急会议任务，可重点关注实时参会专家邀请与日程更新工作');
    parts.push('');
  }

  lastHasTasks = hasTasks;

  // 底部提示
  parts.push('> 📌 持续跟进：实时参会专家邀请 · 更新会议日程');
  parts.push('> ✅ 打勾完成请点击下方任务面板');

  return parts.join('\n');
}

// ═══════════════════════════════════════════
// 发送到企业微信
// ═══════════════════════════════════════════

// 单次发送（带30秒超时）
function sendWeChatMessageOnce(payload) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(payload);
    var options = {
      hostname: 'qyapi.weixin.qq.com',
      path: '/cgi-bin/webhook/send?key=' + WEBHOOK_KEY,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000, // 30秒超时，防止挂起
    };

    var req = https.request(options, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ errcode: -1, errmsg: body });
        }
      });
    });

    req.on('timeout', function() {
      req.destroy(new Error('请求超时（30秒）'));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 带重试的发送（最多3次，每次间隔5秒）
async function sendWeChatMessage(payload, label) {
  var maxRetries = 3;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('  第' + attempt + '次尝试发送' + (label || '') + '...');
      var result = await sendWeChatMessageOnce(payload);
      if (result.errcode === 0) {
        console.log('  ✅ 第' + attempt + '次发送成功');
        return result;
      }
      console.log('  ⚠️ 第' + attempt + '次返回错误: ' + JSON.stringify(result));
    } catch (err) {
      console.log('  ⚠️ 第' + attempt + '次网络错误: ' + err.message);
    }
    if (attempt < maxRetries) {
      console.log('  等待5秒后重试...');
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }
  console.error('❌ ' + (label || '消息') + '发送失败，已重试' + maxRetries + '次');
  return { errcode: -1, errmsg: '发送失败，已重试' + maxRetries + '次' };
}

async function main() {
  var today = getBeijingToday();
  console.log('今天: ' + today.y + '-' + today.m + '-' + today.d + ' ' + today.dayStr);

  // 生成提醒内容
  var markdownContent = generateReminder(today);
  console.log('\n=== 生成的提醒内容 ===');
  console.log(markdownContent);

  // 周末无会议任务 → 不推送，静默退出
  var isWeekend = today.day === 0 || today.day === 6;
  if (isWeekend && !lastHasTasks) {
    console.log('周末无会议现场任务，跳过推送');
    return;
  }

  console.log('\n=== 发送到企业微信 ===');

  // 消息1: markdown任务列表
  console.log('发送 markdown 消息...');
  var result1 = await sendWeChatMessage({
    msgtype: 'markdown',
    markdown: { content: markdownContent },
  }, 'markdown任务列表');
  console.log('markdown 最终结果:', JSON.stringify(result1));

  if (result1.errcode !== 0) {
    console.error('markdown 消息发送失败');
    process.exit(1);
  }

  // 间隔1秒
  await new Promise(function(r) { setTimeout(r, 1000); });

  // 消息2: 任务面板链接卡片
  console.log('发送 news 卡片...');
  var result2 = await sendWeChatMessage({
    msgtype: 'news',
    news: {
      articles: [{
        title: '📋 点击打开今日任务面板（可打勾）',
        description: '打开后逐项打勾完成，全部完成后系统自动记录 ✅',
        url: DASHBOARD_URL,
        picurl: '',
      }],
    },
  }, 'news面板卡片');
  console.log('news 最终结果:', JSON.stringify(result2));

  if (result2.errcode !== 0) {
    console.error('news 卡片发送失败');
    process.exit(1);
  }

  console.log('\n✅ 两条消息都发送成功！');
}

main().catch(function(err) {
  console.error('运行出错:', err);
  process.exit(1);
});
