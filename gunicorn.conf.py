import multiprocessing
import os

workers = min(multiprocessing.cpu_count() * 2 + 1, 4)
worker_class = 'sync'
bind = f"0.0.0.0:{os.environ.get('PORT', '5001')}"
keepalive = 5
timeout = 30
backlog = 2048
worker_connections = 1000
max_requests = 1000
max_requests_jitter = 50
preload_app = True
daemon = False
