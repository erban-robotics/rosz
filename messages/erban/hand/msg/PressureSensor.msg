# 灵巧手压力 (厂商ROS1 hand/PressureSensor 的ROS2镜像, 字段一致). 单手6路: 拇指/食指/中指/无名指/小指指尖, 掌心;
# 当前手型掌心无实际传感器, 第6路无读数
std_msgs/Header header
float64[] pressure
