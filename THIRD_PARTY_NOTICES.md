# 第三方组件与资料说明

本项目通过 ComfyUI 的本机 HTTP 接口编排图像与视频工作流。ComfyUI、各节点插件、Z-Image、FLUX Klein、MiniMax H3、Qwen、llama.cpp、PyAV、NumPy、Pillow 等名称用于说明互操作关系，相关程序与模型不随本仓库分发。

workflows/ 保存已适配的工作流配置，不包含模型权重。使用或分发对应模型、插件及工作流时应核对原始来源的许可与要求。

原电脑上的第三方提示词合集、参考项目源码、个人角色素材、剧本、生成作品与商业资料均未纳入本次仓库。library/catalog.example.json 仅含为本项目编写的通用入门示例。

本仓库当前作为个人源码备份整理；尚未设置统一开源许可证。


高清精修通过spandrel加载作者发布的Real-ESRGAN模型，使用PyTorch与ComfyUI的分块计算工具；不修改ComfyUI核心代码，不随仓库分发模型权重。原项目与许可见 https://github.com/xinntao/Real-ESRGAN 。


角色合成界面、用途映射与适配层为本项目实现。公共参考图片、图片索引和用户上传素材不随本仓库分发。开发机按来源使用 CC0 人像与 Shisei 的 CC0 原创图片；姿势、服装原站仍需遵守逐张参考、禁止批量获取及图片数据再分发等来源条件。图库代码许可与素材许可分别核对。详见[参考图库来源说明](docs/参考图库来源说明.md)。
