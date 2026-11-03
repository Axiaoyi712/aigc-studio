# 我的 AIGC · Personal Creative Studio

基于本机 ComfyUI 的中文 AIGC 创作台，用项目、角色档案和分镜组织图片与短视频制作。当前版本：v0.6.0。

## 功能

- 五步制作：项目设定 → 资产定稿 → 分镜设计 → 生成选片 → 成片归档。
- 每镜支持总提示词、详细画面与动作设置、折叠、排序和历史版本对比。
- 角色固定参考、场景与道具参考；项目首帧最多合并 20 张参考图。
- Z-Image 文生图，FLUX Klein 单图编辑及多图参考，H3 首帧视频与首尾帧过渡。
- 选择并确认历史首帧，视频绑定确认的版本；支持使用上一段视频尾帧。
- 一键串行生成首帧与视频；图片提供横版、竖版、方形 2K 尺寸，视频提供多个时长和分辨率档位。
- 提示词搜索、收藏、自定义与文档导入；可选本地文字助手提供翻译、润色和分镜草稿。
- 每个项目独立保存角色、场景、道具、镜头首帧、视频、音频、成片和 ZIP 归档。
- 本地 Real-ESRGAN 高清精修1080p：保留原片、同步对比、选用高清版本。
- 作品批量隐藏删除、项目删除、剪辑拼接、项目 ZIP 导出与恢复。

参考图和首帧能加强人物约束，无法保证绝对一致。Ref2VA 为实验选项，与首帧图生视频的行为不同。高分辨率与长视频是否可运行取决于显存、模型和具体画面；2K 图片选项不代表这套工作流能原生生成 2K 视频。

## 环境

- Windows 10/11；一键启动针对 ComfyUI Windows portable 目录结构。
- Node.js 22 或以上；Node 服务使用内置模块，无需 npm install。
- 已安装且可运行的 ComfyUI、所需模型与节点，见 [部署与模型](docs/部署与模型.md)。
- Python 3.10+；视频剪辑使用 av、numpy、Pillow，可复用 ComfyUI 自带 Python。

仓库仅包含创作台源码、五份工作流、测试和文档。模型、ComfyUI 本体、个人项目和原有提示词合集需要在本机单独准备。

## 快速开始

1. 克隆或下载本仓库，进入项目目录。
2. 复制配置与提示词示例：

   ~~~powershell
   Copy-Item config.example.json config.json
   Copy-Item library/catalog.example.json library/catalog.json
   ~~~

3. 编辑 config.json：将 comfyRoot 改为本机包含 main.py 的 ComfyUI 绝对目录，确认 comfyUrl 和端口。默认不开启文字助手和 Ref2VA。
4. 便携版 ComfyUI 双击 **启动我的AIGC.cmd**。程序复用已有后台，或启动后台并等待就绪，然后打开创作台。
5. 默认创作台为 http://127.0.0.1:18230；以启动提示为准。如已手动启动本机 ComfyUI，也可运行 npm start。

第一次建议用一个角色、一个场景、三到六个短镜头完成约 20 秒片段。步骤见 [短剧制作指南](制作路线.md)。

## 数据与维护

- config.json 保存本机路径与设置，data/ 保存项目索引和运行记录，均不提交 Git。
- 正式媒体位于 <comfyRoot>/output/AIGC项目/，每个项目下各镜头同级保存。界面可打开相应文件夹。
- ComfyUI input 中保留上传与兼容缓存；不要只按日期手动删除，项目可能仍引用这些文件。
- “我的作品”的删除为隐藏记录，保留媒体和项目引用；不会直接释放对应磁盘空间。
- 项目索引和媒体需一起备份。便于迁移时优先使用界面的完整项目 ZIP 导出；复制仓库源码不包含作品。
- 本机自用服务绑定 127.0.0.1，仓库未提供面向公网的登录及多用户隔离。

## 开发与测试

~~~powershell
npm test
python -m pip install -r requirements-media.txt
python test/test_media.py
~~~

视频测试使用人工合成的小片段，不会向 ComfyUI 提交生成任务。Python 依赖应安装到实际运行媒体脚本的环境；已有 ComfyUI 环境满足依赖时无需重复安装。

GitHub Actions 在 Windows 上运行 Node 与媒体测试；测试结果验证程序行为，不等同于对任意硬件完成真实模型推理验收。

更多说明：[部署与模型](docs/部署与模型.md) · [开发与发布](docs/开发与发布.md) · [第三方说明](THIRD_PARTY_NOTICES.md)
