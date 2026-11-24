# 每个 service 响应的回执. 调用方按 code 分流, message 只给人看, detail_json 给结构化上下文.
# 不设 bool success: code == SUCCESS 即成功.

uint8 SUCCESS=0
uint8 INVALID_REQUEST=1   # 请求字段缺失/格式错/取值非法, 重试同一请求无意义
uint8 NOT_FOUND=2         # 预设名/SDK 方法名不存在
uint8 BUSY=3              # 资源被另一条指令占着, 不排队; detail_json 含 blocked_on/requested/occupancy
uint8 FAILED=4            # 请求合法但执行没成功 (SDK 返回 False, 硬件拒绝, 状态过期)
uint8 INTERNAL_ERROR=5    # bridge 自身问题 (读不到状态, 适配器缺失, 未捕获异常); detail_json 含 traceback
# 6..63 预留给公共码; 接口私有码从 64 起, 在各 .srv 内声明

uint8 code
string message            # 人读的一句话, 调用方不要解析
string detail_json        # 结构化上下文, JSON 对象或空串. 各码的形状见 MAPPING.md "detail_json 约定"
