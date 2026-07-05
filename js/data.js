/* ============ 演示数据（单品 / 成套搭配） ============ */

const ITEMS = [
  { id: "t01", name: "白色T恤",     cat: "上衣", ph: "tee" },
  { id: "t02", name: "黑色T恤",     cat: "上衣", ph: "tee" },
  { id: "t03", name: "条纹衬衫",    cat: "上衣", ph: "shirt" },
  { id: "t04", name: "米色针织衫",  cat: "上衣", ph: "knit" },
  { id: "t05", name: "藏青连帽外套", cat: "上衣", ph: "hoodie" },
  { id: "t06", name: "卡其风衣",    cat: "上衣", ph: "coat" },
  { id: "b01", name: "黑色西裤",    cat: "下装", ph: "pants" },
  { id: "b02", name: "蓝色牛仔裤",  cat: "下装", ph: "jeans" },
  { id: "b03", name: "灰色短裤",    cat: "下装", ph: "shorts" },
  { id: "s01", name: "百褶半身裙",  cat: "下装", ph: "skirt" },
  { id: "s02", name: "绿色连衣裙",  cat: "连体裙", ph: "dress" },
  { id: "f01", name: "黑色帆布鞋",  cat: "鞋子", ph: "sneaker" },
  { id: "f02", name: "白色运动鞋",  cat: "鞋子", ph: "sneaker" },
  { id: "f03", name: "米色高跟鞋",  cat: "鞋子", ph: "heel" },
];

const CATS = ["全部", "上衣", "下装", "鞋子", "连体裙"];

const SCENES = [
  { key: "全部", icon: "✨" },
  { key: "通勤", icon: "💼" },
  { key: "约会", icon: "🌹" },
  { key: "旅行", icon: "🧳" },
  { key: "日常", icon: "☀️" },
  { key: "其他", icon: "🏷️" },
];

const OUTFITS = [
  { id: "o1", name: "极简黑白",  scene: "通勤", items: ["t01", "b01", "f02"], desc: "白T恤配黑西裤，干净利落，适合任何工作场合。" },
  { id: "o2", name: "衬衫质感",  scene: "通勤", items: ["t03", "b01", "f01"], desc: "条纹衬衫自带专业感，帆布鞋中和了严肃气质。" },
  { id: "o3", name: "针织温柔",  scene: "通勤", items: ["t04", "b02", "f02"], desc: "米色针织衫柔化整体轮廓，通勤也可以很松弛。" },
  { id: "o4", name: "裙装优雅",  scene: "约会", items: ["s02", "f03"],        desc: "一条连衣裙解决一切，高跟鞋拉长比例。" },
  { id: "o5", name: "甜酷反差",  scene: "约会", items: ["t02", "s01", "f01"], desc: "黑T恤与百褶裙的反差混搭，甜而不腻。" },
  { id: "o6", name: "舒适出行",  scene: "旅行", items: ["t01", "b03", "f02"], desc: "轻装上阵，怎么走都不累的万能组合。" },
  { id: "o7", name: "风衣叠穿",  scene: "旅行", items: ["t06", "b02", "f01"], desc: "风衣+牛仔裤的经典组合，应对旅途早晚温差。" },
  { id: "o8", name: "连帽休闲",  scene: "日常", items: ["t05", "b02", "f02"], desc: "连帽外套的随性感，适合日常放松的场景。" },
];

const JOBS = {
  "学生": ["高中生", "大学生"],
  "职业": ["教师 / 教授", "软件工程师", "设计师", "产品经理", "创意工作者",
          "市场营销", "咨询", "律师", "投资银行从业者", "人力资源",
          "护士 / 医疗从业者", "自由职业者", "创业者", "公务员",
          "全职父母", "退休人员", "其他"],
};
