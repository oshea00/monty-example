FROM python:3.13

WORKDIR /app

RUN pip install uv

COPY requirements.txt requirements-server.txt ./
RUN uv pip install --system -r requirements.txt -r requirements-server.txt

COPY main.py external_tools.py server.py ./

EXPOSE 8001
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
