import React, { useEffect, useRef } from 'react';
import './TasksWidget.css';

const TasksWidget = ({ tasks, setTasks, showTasks, setShowTasks }) => {
    const taskArray = Object.entries(tasks);
    const containerRef = useRef(null);

    useEffect(() => {
        if (!showTasks) return;

        const handleClickOutside = (event) => {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setShowTasks(false);
            }
        };

        const handleContextMenuOutside = (event) => {
            // Если правый клик произошел вне виджета задач
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                // Если это клик по таблице файлов (пустое место), FilesView сам скроет контекстное меню,
                // но нам нужно скрыть и задачи тоже.
                setShowTasks(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('contextmenu', handleContextMenuOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('contextmenu', handleContextMenuOutside);
        };
    }, [showTasks, setShowTasks]);
    
    if (taskArray.length === 0) return null;

    return (
        <div className="tasks-widget-container no-drag" ref={containerRef}>
            <button 
                className={`tasks-toggle-btn ${showTasks ? 'active' : ''} ${taskArray.some(([_, t]) => t.status === 'error') ? 'has-error' : ''} ${taskArray.some(([_, t]) => t.status === 'copying' || t.status === 'starting') ? 'is-running' : ''}`}
                onClick={() => setShowTasks(!showTasks)}
                title="Задания копирования"
            >
                📁 <span className="tasks-count">{taskArray.length}</span>
            </button>
            
            {showTasks && (
                <div className="tasks-dropdown no-drag">
                    <div className="tasks-dropdown-header">
                        <span className="tasks-dropdown-title">Задания ({taskArray.length})</span>
                        <button 
                            className="tasks-clear-all"
                            onClick={() => setTasks({})}
                        >
                            Очистить всё
                        </button>
                    </div>
                    <div className="tasks-list">
                        {taskArray.map(([id, task]) => (
                            <div key={id} className="task-item">
                                <div className="task-item-info">
                                    <span className="task-item-name" title={task.srcPath}>
                                        {task.srcPath ? task.srcPath.split('/').pop() : 'Unknown file'}
                                    </span>
                                    <span className="task-item-percent">{task.percent}%</span>
                                </div>
                                <div className="task-progress-bar">
                                    <div 
                                        className={`task-progress-fill ${task.status}`}
                                        style={{ width: `${task.percent}%` }}
                                    />
                                </div>
                                {task.status === 'done' && (
                                    <div className="task-status-text status-done">Успешно завершено</div>
                                )}
                                {task.status === 'fallback' && (
                                    <div className="task-status-text status-fallback">Переключение на поток...</div>
                                )}
                                {task.error && (
                                    <div className={`task-status-text ${task.status === 'error' ? 'status-error' : 'status-msg'}`}>
                                        {task.error}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TasksWidget;
