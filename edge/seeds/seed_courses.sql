INSERT INTO enrolled_courses (course_id, class_id, platform, course_name, cpi, teacher_name, updated_at) VALUES
('267082295', '154651310', 'chaoxing', '大学物理B', '340100029', '常英立', datetime('now', '+8 hours')),
('266993333', '154423000', 'chaoxing', '数据结构与算法课程设计', '340100029', '', datetime('now', '+8 hours')),
('267230708', '155058274', 'chaoxing', 'JAVA框架编程', '340100029', '', datetime('now', '+8 hours')),
('267124410', '154778932', 'chaoxing', '数字图像处理', '340100029', '', datetime('now', '+8 hours')),
('267076805', '154640510', 'chaoxing', '离散数学', '340100029', '', datetime('now', '+8 hours')),
('266813180', '153948204', 'chaoxing', '单片机原理与应用', '340100029', '', datetime('now', '+8 hours')),
('268784887', '158750280', 'chaoxing', '高等数学(二)', '340100029', '', datetime('now', '+8 hours')),
('268090261', '157227345', 'chaoxing', '2026JAVA-课程设计', '340100029', '', datetime('now', '+8 hours')),
('267221020', '155032075', 'chaoxing', '大学物理实验', '340100029', '', datetime('now', '+8 hours')),
('267175187', '154913374', 'chaoxing', '形势与政策（3）', '340100029', '', datetime('now', '+8 hours')),
('266748565', '153770526', 'chaoxing', '毛泽东思想和中国特色社会主义理论体系概论', '340100029', '', datetime('now', '+8 hours')),
('268551697', '158256735', 'chaoxing', '养生与健康', '340100029', '', datetime('now', '+8 hours')),
('267429873', '155572427', 'chaoxing', '社会主义发展史', '340100029', '', datetime('now', '+8 hours')),
('267319570', '155288480', 'chaoxing', '中外文明交流史（在线课程）', '340100029', '', datetime('now', '+8 hours')),
('267308545', '155255255', 'chaoxing', '大学体育与健康（3）', '340100029', '', datetime('now', '+8 hours')),
('266874983', '154101446', 'chaoxing', 'LabVIEW编程及应用', '340100029', '', datetime('now', '+8 hours')),
('262338528', '143942458', 'chaoxing', '专业大型综合实验', '340100029', '', datetime('now', '+8 hours')),
('260472511', '139126076', 'chaoxing', '高等数学(二)', '340100029', '', datetime('now', '+8 hours'))
ON CONFLICT(platform, course_id, class_id) DO UPDATE SET
  course_name = excluded.course_name,
  cpi = excluded.cpi,
  teacher_name = excluded.teacher_name,
  updated_at = excluded.updated_at;
